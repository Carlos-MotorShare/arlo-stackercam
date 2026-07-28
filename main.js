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

// Function description: This Cloudflare Worker captures a snapshot from a specified camera entity
// in Home Assistant (or, in test mode, fetches a hosted test image), analyzes the image to determine
// the presence of vehicles in predefined parking spaces, and returns a JSON response with the
// analysis results, including stacker number, level, license plate information, and confidence scores.
//
// ============================================================================
// CHANGES MADE TO RUN ON CLOUDFLARE WORKERS (see full explanation in chat):
//   - sharp            -> @cf-wasm/photon (WASM image lib; sharp needs native
//                          bindings Workers can't run)
//   - fs/path          -> removed; test image is now fetched over HTTP from
//                          env.TEST_IMAGE_URL (no filesystem in Workers)
//   - dotenv/process.env -> config now comes from the `env` object Workers
//                          passes into fetch(), set via wrangler secrets/vars
//   - crypto.createHash("md5") -> crypto.subtle.digest("SHA-256", ...) via
//                          Web Crypto (Node's crypto module isn't available;
//                          Web Crypto doesn't support MD5, so this uses SHA-256
//                          instead for the same change-detection purpose)
//   - @google/genai SDK -> replaced with a direct fetch() to the Gemini REST
//                          API, to avoid any risk of the SDK depending on
//                          Node-only APIs under workerd
//   - axios             -> replaced with native fetch()
// ============================================================================

import {
    PhotonImage,
    crop as photonCrop,
} from "@cf-wasm/photon/workerd";

const CAMERA_ENTITY = "camera.aarlo_stacker_cam";

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

// Small helper so every Home Assistant call doesn't have to rebuild headers.
function haHeaders(env) {
    return {
        Authorization: `Bearer ${env.HOME_ASSISTANT_TOKEN}`,
        "Content-Type": "application/json",
    };
}

async function requestSnapshot(env) {
    console.log("Requesting snapshot...");

    const res = await fetch(
        `${env.HOME_ASSISTANT_URL}/api/services/aarlo/camera_request_snapshot`,
        {
            method: "POST",
            headers: haHeaders(env),
            body: JSON.stringify({ entity_id: CAMERA_ENTITY }),
        }
    );

    if (!res.ok) {
        throw new Error(`Failed to request snapshot: ${res.status} ${res.statusText}`);
    }
}

async function getCameraState(env) {
    const res = await fetch(
        `${env.HOME_ASSISTANT_URL}/api/states/${CAMERA_ENTITY}`,
        { headers: haHeaders(env) }
    );

    if (!res.ok) {
        throw new Error(`Failed to get camera state: ${res.status} ${res.statusText}`);
    }

    return await res.json();
}

// Web Crypto (available natively in Workers) doesn't support MD5, so this
// uses SHA-256 instead. It's only used to detect whether the image bytes
// changed between polls, so any stable hash works equally well here.
async function hashBytes(arrayBuffer) {
    const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
    return [...new Uint8Array(digest)]
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

async function getSnapshotBytes(env) {
    const res = await fetch(
        `${env.HOME_ASSISTANT_URL}/api/camera_proxy/${CAMERA_ENTITY}`,
        { headers: haHeaders(env) }
    );

    if (!res.ok) {
        throw new Error(`Failed to fetch snapshot: ${res.status} ${res.statusText}`);
    }

    return await res.arrayBuffer();
}

async function waitForFreshSnapshot(env) {
    const initialState = await getCameraState(env);
    const initialTime = initialState.last_updated;
    const initialBytes = await getSnapshotBytes(env);
    const initialHash = await hashBytes(initialBytes);

    await requestSnapshot(env);

    for (let i = 0; i < 6; i++) {
        await sleep(10000);

        const state = await getCameraState(env);
        const bytes = await getSnapshotBytes(env);
        const hash = await hashBytes(bytes);

        if (state.last_updated !== initialTime || hash !== initialHash) {
            console.log("Fresh image detected");
            return new Uint8Array(bytes);
        }
    }

    throw new Error("No fresh snapshot received");
}

// Workers have no filesystem, so the "test image" now needs to live
// somewhere fetchable over HTTP - e.g. an R2 bucket with public access,
// a KV-backed endpoint, or just any URL you control. Set TEST_IMAGE_URL
// as a var/secret in wrangler.
async function loadTestImage(env) {
    if (!env.TEST_IMAGE_URL) {
        throw new Error(
            "Test mode requested but TEST_IMAGE_URL is not set. " +
            "Point it at a hosted copy of your test image (e.g. an R2 public URL)."
        );
    }

    console.log(`Using hosted test image: ${env.TEST_IMAGE_URL}`);

    const res = await fetch(env.TEST_IMAGE_URL);

    if (!res.ok) {
        throw new Error(
            `Could not fetch test image at ${env.TEST_IMAGE_URL}: ${res.status} ${res.statusText}`
        );
    }

    return new Uint8Array(await res.arrayBuffer());
}

// Single entry point that decides whether to hit Home Assistant or use the
// hosted test image, based on the USE_TEST_IMAGE env var or a ?test=true query param.
async function getSourceImage(request, env) {
    const url = new URL(request.url);

    const wantsTestImage =
        env.USE_TEST_IMAGE === "true" || url.searchParams.get("test") === "true";

    if (wantsTestImage) {
        return await loadTestImage(env);
    }

    return await waitForFreshSnapshot(env);
}

// Checks every configured crop against the real image dimensions and throws
// one clear error naming the offending space, instead of a generic
// "bad extract area" which doesn't say which space or by how much it's off.
function validateCropBounds(imgWidth, imgHeight) {
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

// NOTE ON EXIF ORIENTATION:
// sharp's `.rotate()` with no args auto-applies the EXIF orientation tag.
// Photon does not currently support reading EXIF orientation, so that
// auto-rotation step has been dropped. If your camera embeds an EXIF
// rotation tag (rather than physically rotating pixels), crop coordinates
// calibrated by eye in a browser may not line up with the raw pixel grid
// here. In practice, Home Assistant's camera_proxy snapshots are usually
// already physically oriented, so this is likely fine - but recalibrate
// your crop coordinates directly against a fetched raw snapshot (not a
// browser preview) if things look offset.

async function analyseParkingSpaces(imageBytes, env) {
    const sourceImage = PhotonImage.new_from_byteslice(imageBytes);
    const imgWidth = sourceImage.get_width();
    const imgHeight = sourceImage.get_height();

    validateCropBounds(imgWidth, imgHeight);

    const parts = [];

    try {
        for (const space of parkingSpaces) {
            console.log("Cropping:", space.id);

            const { left, top, width, height } = space.crop;

            const cropped = photonCrop(
                sourceImage,
                left,
                top,
                left + width,
                top + height
            );

            const jpegBytes = cropped.get_bytes_jpeg(90);
            cropped.free();

            parts.push({
                text: `
Image ID: ${space.id}

Location:
Stacker ${space.stacker}
Level ${space.level}

Analyse this parking position.
                `
            });

            parts.push({
                inlineData: {
                    mimeType: "image/jpeg",
                    data: bytesToBase64(jpegBytes)
                }
            });
        }
    } finally {
        sourceImage.free();
    }

    parts.push({
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
    });

    return await callGemini(parts, env);
}

// Cloudflare Workers don't have Node's Buffer, so base64-encode manually
// via the Web-standard btoa, chunked to avoid blowing the call stack on
// large images.
function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 8192;

    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return btoa(binary);
}

// Calls the Gemini REST API directly instead of using the @google/genai SDK,
// to avoid any risk of the SDK relying on Node-only APIs under workerd.
async function callGemini(parts, env) {
    const model = "gemini-3.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

    const body = {
        contents: [{ parts }],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    cars: {
                        type: "ARRAY",
                        items: {
                            type: "OBJECT",
                            properties: {
                                stacker: { type: "INTEGER" },
                                level: { type: "INTEGER" },
                                plate: { type: "STRING" },
                                confidence: { type: "NUMBER" }
                            },
                            required: ["stacker", "level", "plate", "confidence"]
                        }
                    }
                },
                required: ["cars"]
            }
        }
    };

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini API error: ${res.status} ${res.statusText} - ${errText}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
        throw new Error("Gemini response did not contain the expected text payload.");
    }

    return JSON.parse(text);
}

// FOR CLOUDFLARE WORKERS DEPLOYMENT: entry point. Handles GET and POST
// requests, retrieves the source image (either from Home Assistant or a
// hosted test image), analyzes the parking spaces, and returns the results
// as JSON. Errors are returned as a JSON error payload with a 500 status.
export default {
    async fetch(request, env, ctx) {
        if (request.method !== "GET" && request.method !== "POST") {
            return Response.json(
                { error: "Method not allowed" },
                { status: 405 }
            );
        }

        try {
            const imageBytes = await getSourceImage(request, env);
            const results = await analyseParkingSpaces(imageBytes, env);

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