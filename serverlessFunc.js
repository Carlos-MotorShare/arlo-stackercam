// FUNCTION OUTPUT FORMAT:
// {
//   "cars": [
//     {
//       "stacker": 1,
//       "level": 1,
//       "plate": "ABC123",
//       "confidence": 0.96
//     },
//     {
//       "stacker": 1,
//       "level": 2,
//       "plate": "EMPTY",
//       "confidence": 0.99
//     },
//     {
//       "stacker": 2,
//       "level": 3,
//       "plate": "KLM456",
//       "confidence": 0.87
//     }
//   ]
// }

// Function description: This serverless function captures a snapshot from a specified camera entity in Home Assistant
// (or, in test mode, reads a local test.jpg), analyzes the image to determine the presence of vehicles in predefined
// parking spaces, and returns a JSON response with the analysis results, including stacker number, level, license
// plate information, and confidence scores.

import axios from "axios";
import crypto from "crypto";
import sharp from "sharp";
import fs from "fs/promises";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import "dotenv/config";

const HOME_ASSISTANT_URL = process.env.HOME_ASSISTANT_URL;
const HOME_ASSISTANT_TOKEN = process.env.HOME_ASSISTANT_TOKEN;

const CAMERA_ENTITY = "camera.aarlo_stacker_cam";

// --- Test mode config ---
// Set USE_TEST_IMAGE=true in your environment to always use the local file
// instead of hitting Home Assistant. You can also override per-request with
// a query string, e.g. GET /api/your-function?test=true
const USE_TEST_IMAGE = process.env.USE_TEST_IMAGE === "true";
const TEST_IMAGE_PATH = process.env.TEST_IMAGE_PATH || path.join(process.cwd(), "test.jpg");

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

const headers = {
    Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
    "Content-Type": "application/json",
};

/*
=========================================
PARKING SPACE CONFIGURATION

Replace these coordinates once we know
the real camera layout.

Coordinates are:

left:
distance from left edge

top:
distance from top edge

width:
crop width

height:
crop height

=========================================
*/

const parkingSpaces = [
    {
        id: "S1-L1",
        stacker: 1,
        level: 1,
        crop: { left: 95, top: 2555, width: 811, height: 827 }
    },
    {
        id: "S1-L2",
        stacker: 1,
        level: 2,
        crop: { left: 92, top: 1889, width: 859, height: 531 }
    },
    {
        id: "S1-L3",
        stacker: 1,
        level: 3,
        crop: { left: 103, top: 1259, width: 814, height: 465 }
    },
    {
        id: "S1-L4",
        stacker: 1,
        level: 4,
        crop: { left: 123, top: 874, width: 779, height: 325 }
    },
    {
        id: "S2-L1",
        stacker: 2,
        level: 1,
        crop: { left: 1152, top: 2562, width: 943, height: 721 }
    },
    {
        id: "S3-L1",
        stacker: 3,
        level: 1,
        crop: { left: 2234, top: 2627, width: 718, height: 654 }
    }
];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestSnapshot() {
    console.log("Requesting snapshot...");

    await axios.post(
        `${HOME_ASSISTANT_URL}/api/services/aarlo/camera_request_snapshot`,
        { entity_id: CAMERA_ENTITY },
        { headers }
    );
}

async function getCameraState() {
    const response = await axios.get(
        `${HOME_ASSISTANT_URL}/api/states/${CAMERA_ENTITY}`,
        { headers }
    );

    return response.data;
}

async function getSnapshotHash() {
    const response = await axios.get(
        `${HOME_ASSISTANT_URL}/api/camera_proxy/${CAMERA_ENTITY}`,
        { headers, responseType: "arraybuffer" }
    );

    return crypto.createHash("md5").update(response.data).digest("hex");
}

async function downloadSnapshot() {
    const response = await axios.get(
        `${HOME_ASSISTANT_URL}/api/camera_proxy/${CAMERA_ENTITY}`,
        { headers, responseType: "arraybuffer" }
    );

    return Buffer.from(response.data);
}

async function waitForFreshSnapshot() {
    const initialState = await getCameraState();
    const initialTime = initialState.last_updated;
    const initialHash = await getSnapshotHash();

    await requestSnapshot();

    for (let i = 0; i < 6; i++) {
        await sleep(10000);

        const state = await getCameraState();
        const hash = await getSnapshotHash();

        if (state.last_updated !== initialTime || hash !== initialHash) {
            console.log("Fresh image detected");
            return await downloadSnapshot();
        }
    }

    throw new Error("No fresh snapshot received");
}

// Reads the local test image from disk. Throws a clear error if it's missing
// so you're not stuck debugging a cryptic sharp/Gemini failure instead.
async function loadTestImage() {
    console.log(`Using local test image: ${TEST_IMAGE_PATH}`);

    try {
        return await fs.readFile(TEST_IMAGE_PATH);
    } catch (err) {
        throw new Error(
            `Could not read test image at ${TEST_IMAGE_PATH}. ` +
            `Make sure test.jpg exists there, or set TEST_IMAGE_PATH. (${err.message})`
        );
    }
}

// Single entry point that decides whether to hit Home Assistant or use the
// local test file, based on the USE_TEST_IMAGE env var or a ?test=true query param.
async function getSourceImage(req) {
    const wantsTestImage = USE_TEST_IMAGE || req?.query?.test === "true";

    if (wantsTestImage) {
        return await loadTestImage();
    }

    return await waitForFreshSnapshot();
}

// Checks every configured crop against the real image dimensions and throws
// one clear error naming the offending space, instead of sharp's generic
// "bad extract area" which doesn't say which space or by how much it's off.
async function validateCropBounds(imageBuffer) {
    const { width: imgWidth, height: imgHeight } = await sharp(imageBuffer).metadata();

    console.log(`Source image is ${imgWidth}x${imgHeight}`);

    const problems = [];

    for (const space of parkingSpaces) {
        const { left, top, width, height } = space.crop;
        const right = left + width;
        const bottom = top + height;

        if (left < 0 || top < 0 || right > imgWidth || bottom > imgHeight) {
            problems.push(
                `${space.id}: crop (left ${left}, top ${top}, ${width}x${height}) ` +
                `needs the image to be at least ${right}x${bottom}, but it's only ${imgWidth}x${imgHeight}`
            );
        }
    }

    if (problems.length > 0) {
        throw new Error(
            `${problems.length} parking space crop(s) fall outside the image bounds:\n` +
            problems.join("\n") +
            `\n\nUse the crop calibrator tool against this same image to get corrected coordinates.`
        );
    }
}

// Some cameras save an EXIF orientation tag instead of physically rotating
// the pixels. Browsers (and therefore the crop calibrator tool) auto-apply
// that rotation when displaying the image, but sharp does not apply it by
// default. Without this step, coordinates calibrated visually in a browser
// won't line up with the raw pixel grid sharp crops against. Calling
// .rotate() with no arguments auto-rotates based on the EXIF tag and then
// strips it, so everything downstream works in the same, single orientation.
async function normalizeOrientation(imageBuffer) {
    return await sharp(imageBuffer).rotate().toBuffer();
}
 

async function analyseParkingSpaces(imageBuffer) {
    await validateCropBounds(imageBuffer);

    const imageContents = [];

    // Create labelled image inputs
    for (const space of parkingSpaces) {
        console.log("Cropping:", space.id);

        const crop = await sharp(imageBuffer)
            .extract(space.crop)
            .jpeg()
            .toBuffer();

        imageContents.push({
            text: `
Image ID: ${space.id}

Location:
Stacker ${space.stacker}
Level ${space.level}

Analyse this parking position.
            `
        });

        imageContents.push({
            inlineData: {
                mimeType: "image/jpeg",
                data: crop.toString("base64")
            }
        });
    }

    // Single Gemini request covering every crop
    const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",

        contents: [
            ...imageContents,
            {
                text: `
You are analysing an automated vehicle storage facility.

There are 3 vehicle stackers.

Each stacker has 4 levels.

You have been provided individual cropped images of each parking position.

For every image:

1. Determine whether a vehicle is present.
2. Read the licence plate if visible.
3. Return the stacker number.
4. Return the level.
5. Provide confidence between 0 and 1.

Rules:

- If no vehicle exists, return plate as "EMPTY".
- Do not guess plates.
- If the plate cannot be read, return "UNKNOWN".
- Only return JSON in this format (example):

    {
       "stacker": 1,
       "level": 1,
       "plate": "ABC123",
       "confidence": 0.96
     },
                `
            }
        ],

        config: {
            responseMimeType: "application/json",

            responseSchema: {
                type: Type.OBJECT,

                properties: {
                    cars: {
                        type: Type.ARRAY,

                        items: {
                            type: Type.OBJECT,

                            properties: {
                                stacker: { type: Type.INTEGER },
                                level: { type: Type.INTEGER },
                                plate: { type: Type.STRING },
                                confidence: { type: Type.NUMBER }
                            },

                            required: ["stacker", "level", "plate", "confidence"]
                        }
                    }
                },

                required: ["cars"]
            }
        }
    });

    return JSON.parse(response.text);
}


// FOR VERCEL SERVERLESS DEPLOYMENT: This is the entry point for the serverless function. It handles GET and POST requests, retrieves the source image (either from Home Assistant or a local test file), normalizes its orientation, analyzes the parking spaces, and returns the results in JSON format. If any errors occur during processing, it responds with an appropriate error message and status code.
// export default async function handler(req, res) {
//     if (req.method !== "GET" && req.method !== "POST") {
//         return res.status(405).json({ error: "Method not allowed" });
//     }

//     try {
//         const rawImage = await getSourceImage(req);
//         const image = await normalizeOrientation(rawImage);
//         const results = await analyseParkingSpaces(image);

//         return res.status(200).json({
//             timestamp: new Date().toISOString(),
//             cars: results
//         });
//     } catch (err) {
//         console.error(err);
//         return res.status(500).json({ error: err.message });
//     }
// }



// FOR CLOUD FLARE WORKERS DEPLOYMENT: This is the entry point for the serverless function. It handles GET and POST requests, retrieves the source image (either from Home Assistant or a local test file), normalizes its orientation, analyzes the parking spaces, and returns the results in JSON format. If any errors occur during processing, it responds with an appropriate error message and status code.
export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET" && request.method !== "POST") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405 }
      );
    }

    try {
      const rawImage = await getSourceImage(request);
      const image = await normalizeOrientation(rawImage);
      const results = await analyseParkingSpaces(image);

      return Response.json(
        {
          timestamp: new Date().toISOString(),
          cars: results,
        },
        { status: 200 }
      );
    } catch (err) {
      console.error(err);

      return Response.json(
        {
          error: err instanceof Error ? err.message : String(err),
        },
        { status: 500 }
      );
    }
  },
};


// FOR LOCAL TESTING ONLY: Uncomment the following lines to run this script directly with Node.js

// const req = {
//   method: "GET",
//     query: {
//         test: "true"
//     }
// };

// const res = {
//   status(code) {
//     console.log("Status:", code);
//     return this;
//   },
//   json(data) {
//     console.log(JSON.stringify(data, null, 2));
//   }
// };

// await handler(req, res);