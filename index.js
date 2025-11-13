const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (
        !origin ||
        !allowedOrigins.length ||
        allowedOrigins.includes(origin)
      ) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.dojua2g.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let database;
let collections = {};
let connectionPromise;

const asyncHandler = (handler) => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (error) {
    next(error);
  }
};

const connectToDatabase = async () => {
  if (database) {
    return database;
  }

  if (!connectionPromise) {
    connectionPromise = client
      .connect()
      .then(() => {
        database = client.db("agroBridgeDB");
        collections = {
          crops: database.collection("crops"),
          users: database.collection("users"),
        };

        return Promise.all([
          collections.crops.createIndex(
            { name: 1, type: 1, location: 1, description: 1 },
            { name: "crop_field_index" }
          ),
          collections.users.createIndex({ email: 1 }, { unique: true }),
        ]);
      })
      .then(() => {
        console.log("Connected to MongoDB and ensured indexes are created");
        return database;
      })
      .catch((error) => {
        connectionPromise = null;
        throw error;
      });
  }

  return connectionPromise;
};

const getCollections = async () => {
  await connectToDatabase();
  return collections;
};

const CROP_EDITABLE_FIELDS = [
  "name",
  "type",
  "pricePerUnit",
  "unit",
  "quantity",
  "description",
  "location",
  "image",
];

const buildIdFilter = (id) => {
  if (ObjectId.isValid(id)) {
    return { $or: [{ _id: new ObjectId(id) }, { _id: id }] };
  }
  return { _id: id };
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildOwnerEmailFilter = (email) => ({
  "owner.ownerEmail": { $regex: `^${escapeRegex(email)}$`, $options: "i" },
});

const buildNewCropDocument = (payload) => {
  const requiredFields = [
    "name",
    "type",
    "pricePerUnit",
    "unit",
    "quantity",
    "description",
    "location",
    "image",
  ];

  const missingField = requiredFields.some((field) => {
    const value = payload[field];
    return value === undefined || value === null || value === "";
  });

  if (
    missingField ||
    !payload.owner ||
    !payload.owner.ownerEmail ||
    !payload.owner.ownerName
  ) {
    return { error: { status: 400, message: "Missing required crop fields" } };
  }

  const numericPrice = Number(payload.pricePerUnit);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    return {
      error: {
        status: 400,
        message: "Price per unit must be a positive number",
      },
    };
  }

  const numericQuantity = Number(payload.quantity);
  if (!Number.isFinite(numericQuantity) || numericQuantity < 0) {
    return {
      error: { status: 400, message: "Quantity must be zero or more" },
    };
  }

  return {
    value: {
      name: payload.name,
      type: payload.type,
      pricePerUnit: numericPrice,
      unit: payload.unit,
      quantity: numericQuantity,
      description: payload.description,
      location: payload.location,
      image: payload.image,
      owner: payload.owner,
      interests: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
};

const buildCropUpdates = (payload) => {
  const updates = {};

  for (const field of CROP_EDITABLE_FIELDS) {
    if (payload[field] !== undefined) {
      updates[field] =
        field === "pricePerUnit" || field === "quantity"
          ? Number(payload[field])
          : payload[field];
    }
  }

  if (!Object.keys(updates).length) {
    return {
      error: { status: 400, message: "No valid fields provided for update" },
    };
  }

  if (
    (updates.pricePerUnit !== undefined &&
      (!Number.isFinite(updates.pricePerUnit) || updates.pricePerUnit <= 0)) ||
    (updates.quantity !== undefined &&
      (!Number.isFinite(updates.quantity) || updates.quantity < 0))
  ) {
    return {
      error: { status: 400, message: "Invalid numeric value in the payload" },
    };
  }

  return { value: updates };
};

app.get("/", (req, res) => {
  res.send("AgroBridge Server is running");
});

app.get(
  "/api/health",
  asyncHandler(async (req, res) => {
    await connectToDatabase();
    res.json({ status: "ok" });
  })
);

app.get(
  "/api/crops/latest",
  asyncHandler(async (req, res) => {
    const { crops } = await getCollections();
    const limit = Math.min(parseInt(req.query.limit, 10) || 6, 20);
    const latestCrops = await crops
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    res.json(latestCrops);
  })
);

app.get(
  "/api/crops",
  asyncHandler(async (req, res) => {
    const { crops } = await getCollections();
    const { search, ownerEmail } = req.query;
    const query = {};

    if (search) {
      const regex = new RegExp(search, "i");
      query.$or = [
        { name: regex },
        { type: regex },
        { location: regex },
        { description: regex },
      ];
    }

    if (ownerEmail) {
      query["owner.ownerEmail"] = ownerEmail;
    }

    const cropsList = await crops.find(query).sort({ createdAt: -1 }).toArray();
    res.json(cropsList);
  })
);

app.get(
  "/api/crops/:id",
  asyncHandler(async (req, res) => {
    const { crops } = await getCollections();
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid crop id" });
    }

    const crop = await crops.findOne({ _id: new ObjectId(id) });
    if (!crop) {
      return res.status(404).json({ message: "Crop not found" });
    }

    res.json(crop);
  })
);

app.post(
  "/api/crops",
  asyncHandler(async (req, res) => {
    const { crops } = await getCollections();
    const { value, error } = buildNewCropDocument(req.body);

    if (error) {
      return res.status(error.status).json({ message: error.message });
    }

    const result = await crops.insertOne(value);
    res.status(201).json({ ...value, _id: result.insertedId });
  })
);

app.put(
  "/api/crops/:id",
  asyncHandler(async (req, res) => {
    const { crops } = await getCollections();
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid crop id" });
    }

    const { value: updates, error } = buildCropUpdates(req.body);
    if (error) {
      return res.status(error.status).json({ message: error.message });
    }

    const updated = await crops.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { ...updates, updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    if (!updated.value) {
      return res.status(404).json({ message: "Crop not found" });
    }

    res.json(updated.value);
  })
);

app.get(
  "/api/my/crops",
  asyncHandler(async (req, res) => {
    const { crops } = await getCollections();
    const { ownerEmail, search } = req.query;

    if (!ownerEmail) {
      return res
        .status(400)
        .json({ message: "ownerEmail query parameter is required" });
    }

    const query = { ...buildOwnerEmailFilter(ownerEmail) };
    if (search) {
      const regex = new RegExp(search, "i");
      query.$or = [
        { name: regex },
        { type: regex },
        { location: regex },
        { description: regex },
      ];
    }

    const ownedCrops = await crops
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();
    res.json(ownedCrops);
  })
);

app.patch(
  "/api/my/crops/:id",
  asyncHandler(async (req, res) => {
    const { crops } = await getCollections();
    const { id } = req.params;
    const { ownerEmail } = req.body || {};

    if (!ownerEmail) {
      return res.status(400).json({ message: "ownerEmail is required" });
    }

    const { value: updates, error } = buildCropUpdates(req.body);
    if (error) {
      return res.status(error.status).json({ message: error.message });
    }

    const filter = {
      ...buildIdFilter(id),
      ...buildOwnerEmailFilter(ownerEmail),
    };
    const updated = await crops.findOneAndUpdate(
      filter,
      { $set: { ...updates, updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    if (!updated.value) {
      return res.status(404).json({ message: "Crop not found" });
    }

    res.json(updated.value);
  })
);

app.patch(
  "/api/crops/:id/basic",
  asyncHandler(async (req, res) => {
    const { crops } = await getCollections();
    const { id } = req.params;

    const { value: updates, error } = buildCropUpdates(req.body);
    if (error) {
      return res.status(error.status).json({ message: error.message });
    }

    const updated = await crops.findOneAndUpdate(
      buildIdFilter(id),
      { $set: { ...updates, updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    // if (!updated.value) {
    //   return res.status(404).json();
    // }

    res.json(updated.value);
  })
);

app.delete(
  "/api/crops/:id",
  asyncHandler(async (req, res) => {
    const { crops } = await getCollections();
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid crop id" });
    }

    const result = await crops.deleteOne({ _id: new ObjectId(id) });
    if (!result.deletedCount) {
      return res.status(404).json({ message: "Crop not found" });
    }

    res.json({ acknowledged: true });
  })
);

app.post(
  "/api/interests",
  asyncHandler(async (req, res) => {
    const { crops } = await getCollections();
    const { cropId, userEmail, userName, userPhoto, quantity, message } =
      req.body;

    if (!cropId || !userEmail || !userName || !quantity) {
      return resneed
        .status(400)
        .json({ message: "Missing required interest fields" });
    }

    if (!ObjectId.isValid(cropId)) {
      return res.status(400).json({ message: "Invalid crop id" });
    }

    const numericQuantity = Number(quantity);
    if (!Number.isFinite(numericQuantity) || numericQuantity < 1) {
      return res.status(400).json({ message: "Quantity must be at least 1" });
    }

    const crop = await crops.findOne({ _id: new ObjectId(cropId) });
    if (!crop) {
      return res.status(404).json({ message: "Crop not found" });
    }

    if (crop.owner?.ownerEmail === userEmail) {
      return res.status(400).json({ message: "Owners cannot send interests" });
    }

    const alreadyInterested = (crop.interests || []).some(
      (interest) => interest.userEmail === userEmail
    );
    if (alreadyInterested) {
      return res
        .status(409)
        .json({ message: "You have already sent interest for this crop" });
    }

    const interestId = new ObjectId();
    const totalPrice = numericQuantity * crop.pricePerUnit;
    const newInterest = {
      _id: interestId,
      cropId,
      cropName: crop.name,
      ownerEmail: crop.owner?.ownerEmail,
      ownerName: crop.owner?.ownerName,
      userEmail,
      userName,
      userPhoto: userPhoto || null,
      quantity: numericQuantity,
      message: message || "",
      totalPrice,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const updated = await crops.findOneAndUpdate(
      { _id: crop._id },
      { $push: { interests: newInterest }, $set: { updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    res.status(201).json({ crop: updated.value, interest: newInterest });
  })
);

app.get(
  "/api/interests",
  asyncHandler(async (req, res) => {
    const { crops } = await getCollections();
    const { email, sort } = req.query;

    if (!email) {
      return res
        .status(400)
        .json({ message: "Email query parameter is required" });
    }

    const pipeline = [
      { $match: { "interests.userEmail": email } },
      { $unwind: "$interests" },
      { $match: { "interests.userEmail": email } },
      {
        $addFields: {
          "interests.cropName": "$name",
          "interests.cropImage": "$image",
          "interests.pricePerUnit": "$pricePerUnit",
          "interests.unit": "$unit",
          "interests.location": "$location",
        },
      },
      { $replaceRoot: { newRoot: "$interests" } },
    ];

    const sortStage = {};
    switch (sort) {
      case "quantity-desc":
        sortStage.quantity = -1;
        break;
      case "quantity-asc":
        sortStage.quantity = 1;
        break;
      case "status":
        sortStage.status = 1;
        sortStage.createdAt = -1;
        break;
      default:
        sortStage.createdAt = -1;
    }

    pipeline.push({ $sort: sortStage });
    const interests = await crops.aggregate(pipeline).toArray();
    res.json(interests);
  })
);

app.patch(
  "/api/interests/:interestId/status",
  asyncHandler(async (req, res) => {
    const { crops } = await getCollections();
    const { interestId } = req.params;
    const { cropId, status } = req.body;

    if (!cropId || !status) {
      return res
        .status(400)
        .json({ message: "cropId and status are required" });
    }

    if (!ObjectId.isValid(cropId) || !ObjectId.isValid(interestId)) {
      return res.status(400).json({ message: "Invalid id provided" });
    }

    if (!["pending", "accepted", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const cropObjectId = new ObjectId(cropId);
    const interestObjectId = new ObjectId(interestId);

    const crop = await crops.findOne({ _id: cropObjectId });
    if (!crop) {
      return res.status(404).json({ message: "Crop not found" });
    }

    const interest = (crop.interests || []).find((item) =>
      item._id.equals(interestObjectId)
    );

    if (!interest) {
      return res.status(404).json({ message: "Interest not found" });
    }

    let updatedQuantity = crop.quantity;
    if (status === "accepted") {
      if (crop.quantity < interest.quantity) {
        return res.status(400).json({ message: "Insufficient crop quantity" });
      }
      updatedQuantity = crop.quantity - interest.quantity;
    }

    const updateDoc = {
      $set: {
        "interests.$.status": status,
        "interests.$.updatedAt": new Date(),
        updatedAt: new Date(),
      },
    };

    if (status === "accepted") {
      updateDoc.$set.quantity = updatedQuantity;
    }

    const updated = await crops.findOneAndUpdate(
      { _id: cropObjectId, "interests._id": interestObjectId },
      updateDoc,
      { returnDocument: "after" }
    );

    // if (!updated.value) {
    //   return res.status(404).json({ message: "Interest update failed" });
    // }

    res.json(updated.value);
  })
);

app.post(
  "/api/users",
  asyncHandler(async (req, res) => {
    const { users } = await getCollections();
    const { email, name, photo } = req.body;

    if (!email || !name) {
      return res.status(400).json({ message: "Name and email are required" });
    }

    const now = new Date();
    const updateResult = await users.findOneAndUpdate(
      { email },
      {
        $setOnInsert: { email, createdAt: now },
        $set: { name, photo: photo ?? null, updatedAt: now },
      },
      { upsert: true, returnDocument: "after" }
    );

    let savedUser = updateResult.value;
    if (!savedUser) {
      savedUser = await users.findOne({ email });
    }

    res.status(200).json(savedUser);
  })
);

app.get(
  "/api/users/:email",
  asyncHandler(async (req, res) => {
    const { users } = await getCollections();
    const { email } = req.params;

    const user = await users.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user);
  })
);

app.patch(
  "/api/users/:email",
  asyncHandler(async (req, res) => {
    const { users } = await getCollections();
    const { email } = req.params;
    const { name, photo } = req.body;

    if (!name && photo === undefined) {
      return res.status(400).json({ message: "No update fields provided" });
    }

    const updated = await users.findOneAndUpdate(
      { email },
      {
        $set: {
          ...(name && { name }),
          ...(photo !== undefined && { photo }),
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    );

    if (!updated.value) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(updated.value);
  })
);

app.use((err, req, res, next) => {
  if (err.message === "Not allowed by CORS") {
    return res.status(403).json({ message: err.message });
  }

  console.error("Unhandled error", err);
  return res.status(500).json({ message: "Internal server error" });
});

connectToDatabase()
  .then(() => console.log("MongoDB connection initialised"))
  .catch((error) => console.error("Failed to initialise MongoDB", error));

app.listen(port, () => {
  console.log(`AgroBridge Server is running on port: ${port}`);
});
