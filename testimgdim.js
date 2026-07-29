import axios from "axios";
import fs from "fs/promises";
import "dotenv/config";

const HOME_ASSISTANT_URL = process.env.HOME_ASSISTANT_URL;
const HOME_ASSISTANT_TOKEN = process.env.HOME_ASSISTANT_TOKEN;

const CAMERA_ENTITY = "camera.aarlo_stacker_cam";

const headers = {
    Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
    "Content-Type": "application/json",
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestSnapshot() {
    console.log("Requesting snapshot...");

    await axios.post(
        `${HOME_ASSISTANT_URL}/api/services/aarlo/camera_request_snapshot`,
        {
            entity_id: CAMERA_ENTITY,
        },
        {
            headers,
        }
    );

    console.log("Snapshot requested.");
}

async function downloadSnapshot() {
    console.log("Downloading snapshot...");

    const response = await axios.get(
        `${HOME_ASSISTANT_URL}/api/camera_proxy/${CAMERA_ENTITY}`,
        {
            headers,
            responseType: "arraybuffer",
        }
    );

    return Buffer.from(response.data);
}

async function main() {
    try {
        await requestSnapshot();

        console.log("Waiting 10 seconds...");
        await sleep(10000);

        const image = await downloadSnapshot();

        await fs.writeFile("./snapshot.jpg", image);

        console.log("✅ Snapshot saved to:");
        console.log("./snapshot.jpg");
    } catch (err) {
        console.error("❌ Error:");
        console.error(err.response?.data || err.message || err);
    }
}

await main();