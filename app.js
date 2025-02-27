require('dotenv').config();
const cheerio = require('cheerio');
const cron = require('node-cron');
const { IncomingWebhook } = require('@slack/webhook');
const OpenAI = require('openai');
const puppeteer = require('puppeteer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const axios = require('axios');
const crypto = require('crypto');

const websiteUrl = 'https://tullin.munu.shop/meny';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  executablePath: '/usr/bin/chromium-browser',
});

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true, // <--- Add this line
});

async function uploadToR2(imageUrl, fileName) {
  try {
    // Fetch the image data
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);

    // Generate a unique key for the file
    const uniqueKey = crypto.randomUUID();
    const objectKey = `${uniqueKey}-${fileName}`;

    // Upload to R2
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: objectKey,
      Body: buffer,
      ContentType: 'image/png',
    });
    await s3.send(command);

    const publicUrl = `https://${process.env.R2_PUBLIC_DOMAIN}/${objectKey}`;

    return publicUrl;
  } catch (error) {
    console.error('Error uploading to R2:', error);
    throw error;
  }
}

const fetchWebsite = async (url) => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox'],
  });

  try {
    const page = await browser.newPage();

    await page.goto(url);
    await page.waitForNetworkIdle();

    const content = await page.content();
    return content;
  } catch (error) {
    console.error('Error fetching website with Puppeteer:', error);
  } finally {
    await browser.close();
  }
};

function extractMenu(html) {
  const $ = cheerio.load(html);
  const menuElement = $('.static-container');
  return menuElement.html();
}

function extractMenuForDay(html) {
  const $ = cheerio.load(html);
  const menuElement = $('.static-container');
  const daysOfWeek = ['Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag'];
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

  return menuItems.join('\n').trim();
}

// Brukes når HTML er dårlig strukturert
async function extractMenuWithAI(html) {
  const $ = cheerio.load(html);
  const menuElement = $('.static-container').children().text();

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  const prompt = `Extract ${today}'s cafeteria menu from the text below:\n\n${menuElement} - output in Norwegian`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 250,
    });

    return response.choices[0]?.message?.content.trim();
  } catch (error) {
    console.error('Error extracting menu with AI:', error);
  }
}

async function generateMenuImage(prompt, menuText) {
  try {
    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt: `${prompt}\n${menuText}\n The image should not have any text in it.`,
      n: 1,
      size: '1024x1024',
    });
    const imageUrl = response.data[0]?.url;

    if (imageUrl) {
      const uploadedUrl = await uploadToR2(imageUrl, 'menu-image.png');
      return uploadedUrl;
    } else {
      throw new Error('Failed to generate image URL');
    }
  } catch (error) {
    console.error('Error generating image with AI:', error);
  }
}

async function sendToSlack(menuText, imageUrl, prompt) {
  const webhook = new IncomingWebhook(process.env.SLACK_WEBHOOK_URL);

  try {
    await webhook.send({
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Dagens meny hos <${websiteUrl}|Smaus>:*`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${menuText}`,
          },
        },
        {
          type: 'image',
          image_url: imageUrl,
          alt_text: 'Cafeteria menu image',
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Prompt*: ${prompt}`,
          },
        },
      ],
    });
  } catch (error) {
    console.error('Error sending message to Slack:', error);
  }
}

const imagePrompts = [
  "Create a visually appealing image in the style of Van Gogh's Starry Night that represents the following cafeteria menu:",
  "Create a visually appealing image in the style of Edvard Munch's Skrik that represents the following cafeteria menu:",
  "Create a visually appealing image in the color palette of Johannes Vermeer's Girl with a Pearl Earring that represents the following cafeteria menu:",
  "Create a visually appealing image in the style of Claude Monet's Impression, Sunrise that represents the following cafeteria menu:",
  'Close-up photograph of a delicious and appealing meal from the cafeteria menu:',
  'Appealing illustration of a meal from the cafeteria menu in a cartoon style:',
  'Surreal and visually appealing image in a fantasy setting that represents the following cafteria menu:',
  'Abstract representation of a meal from the cafeteria menu:',
  'Create a visually appealing image in the style of minimalism that represents the cafeteria menu:',
];

async function main() {
  console.info("I'm starting, hold on!");
  try {
    console.info('Fetching website...');
    const html = await fetchWebsite(websiteUrl);

    console.info('Extracting menu...');
    const menuText = extractMenuForDay(html);
    const menuTextAi = await extractMenuWithAI(html);

    console.info('Generating image from text: ', menuTextAi);

    const randomPrompt =
      imagePrompts[Math.floor(Math.random() * imagePrompts.length)];
    console.log(randomPrompt, menuTextAi);

    const imageUrl = await generateMenuImage(randomPrompt, menuTextAi);

    console.info('Sending to Slack...');
    await sendToSlack(menuTextAi, imageUrl, randomPrompt);
    console.info("I'm done, bye!");
    process.exit(0);
  } catch (error) {
    console.error('Error: ', error);
    process.exit(1);
  }
}

main();

/* cron.schedule('0 10 * * 1-5', () => {
  main();
}); */
