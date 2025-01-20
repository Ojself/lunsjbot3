require("dotenv").config();
const cheerio = require("cheerio");
const cron = require("node-cron");
const { IncomingWebhook } = require("@slack/webhook");
const OpenAI = require("openai");
const puppeteer = require("puppeteer");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const axios = require("axios");
const crypto = require("crypto");

const websiteUrl = "https://tullin.munu.shop/meny";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  executablePath: "/usr/bin/chromium-browser",
});

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function uploadToR2(imageUrl, fileName) {
  try {
    // Fetch the image data
    const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
    const buffer = Buffer.from(response.data);

    // Generate a unique key for the file
    const uniqueKey = crypto.randomUUID();

    // Upload to R2
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: `${uniqueKey}-${fileName}`,
      Body: buffer,
      ContentType: "image/png",
    });

    await s3.send(command);

    // Generate a signed URL valid for 24 hours
    const signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: `${uniqueKey}-${fileName}`,
      }),
      { expiresIn: 432000 } // URL valid for 5 days
    );

    return signedUrl;
  } catch (error) {
    console.error("Error uploading to R2:", error);
    throw error;
  }
}

const fetchWebsite = async (url) => {
  const browser = await puppeteer.launch({ headless: true });

  try {
    const page = await browser.newPage();

    await page.goto(url);
    await page.waitForNetworkIdle();

    const content = await page.content();
    return content;
  } catch (error) {
    console.error("Error fetching website with Puppeteer:", error);
  } finally {
    await browser.close();
  }
};

function extractMenu(html) {
  const $ = cheerio.load(html);
  const menuElement = $(".static-container");
  return menuElement.html();
}

function extractMenuForDay(html) {
  const $ = cheerio.load(html);
  const menuElement = $(".static-container");
  const daysOfWeek = ["Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag"];
  const today = daysOfWeek[new Date().getDay() - 1];

  const menuItems = [];
  let foundToday = false;

  menuElement.children().each((_, el) => {
    const text = $(el).text().trim();

    if (text === today) {
      foundToday = true;
    } else if (daysOfWeek.includes(text)) {
      foundToday = false;
    }

    if (foundToday && !daysOfWeek.includes(text)) {
      menuItems.push(text);
    }
  });

  return menuItems.join("\n").trim();
}

// Brukes når HTML er dårlig strukturert
async function extractMenuWithAI(html) {
  const $ = cheerio.load(html);
  const menuElement = $(".static-container").children().text();

  const today = new Date().toLocaleDateString("en-US", { weekday: "long" });
  const prompt = `Extract ${today}'s cafeteria menu from the text below:\n\n${menuElement} - output in Norwegian`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 250,
    });

    return response.choices[0]?.message?.content.trim();
  } catch (error) {
    console.error("Error extracting menu with AI:", error);
  }
}

async function generateMenuImage(menuText) {
  try {
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: `Create a visually appealing image with no text that represents the following cafeteria menu:\n${menuText}`,
      n: 1,
      size: "1024x1024",
    });
    const imageUrl = response.data[0]?.url;

    if (imageUrl) {
      const uploadedUrl = await uploadToR2(imageUrl, "menu-image.png");
      return uploadedUrl;
    } else {
      throw new Error("Failed to generate image URL");
    }
  } catch (error) {
    console.error("Error generating image with AI:", error);
  }
}

async function sendToSlack(menuText, imageUrl) {
  const webhook = new IncomingWebhook(process.env.SLACK_WEBHOOK_URL);

  try {
    await webhook.send({
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Dagens meny hos <${websiteUrl}|Smaus>:*`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${menuText}`,
          },
        },
        {
          type: "image",
          image_url: imageUrl,
          alt_text: "Cafeteria menu image",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Vil du bidra? Ta kontakt*",
          },
        },
      ],
    });
  } catch (error) {
    console.error("Error sending message to Slack:", error);
  }
}

async function main() {
  console.info("I'm starting, hold on!");
  try {
    console.info("Fetching website...");
    const html = await fetchWebsite(websiteUrl);

    console.info("Extracting menu...");
    const menuText = extractMenuForDay(html);
    const menuTextAi = await extractMenuWithAI(html);

    console.info("Generating image from text: ", menuTextAi);
    const imageUrl = await generateMenuImage(menuTextAi);

    console.info("Sending to Slack...");
    await sendToSlack(menuTextAi, imageUrl);
    console.info("I'm done, bye!");
    process.exit(0);
  } catch (error) {
    console.error("Error: ", error);
    process.exit(1);
  }
}

main();

/* cron.schedule('0 10 * * 1-5', () => {
  main();
}); */
