require('dotenv').config();
const cheerio = require('cheerio');
// const cron = require('node-cron');
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
  forcePathStyle: true,
});

async function uploadToR2(imageData, fileName) {
  try {
    let buffer;

    if (imageData.startsWith('data:')) {
      // Handle base64 data URI
      const base64Data = imageData.split(',')[1];
      buffer = Buffer.from(base64Data, 'base64');
    } else {
      // Handle image URL
      const response = await axios.get(imageData, { responseType: 'arraybuffer' });
      buffer = Buffer.from(response.data);
    }

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
async function extractMenuForDayWithAI(html) {
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

async function generateMenuImage(prompt) {
  try {
    const response = await openai.images.generate({
      model: 'gpt-image-1',
      prompt: prompt,
      n: 1,
      size: '1024x1024',
    });
  
    const b64_json = response.data[0]?.b64_json;

    if (b64_json) {
      const imageUrl = `data:image/png;base64,${b64_json}`;
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
        /* {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Prompt*: ${prompt}`,
          },
        }, */
      ],
    });
  } catch (error) {
    console.error('Error sending message to Slack:', error);
  }
}

async function extractAndNormalizeMenu(html) {
  const $ = cheerio.load(html);
  const raw = $('.static-container').text();

  // Eksempel på JSON Schema for strukturert meny
  const menuSchema = {
    name: "MenuForToday",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        language: { type: "string", enum: ["nb-NO"] },
        day_detected: { type: "string", description: "Mandag–Fredag på norsk" },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string", description: "Kort norsk navn på retten, rettet for stavefeil" },
              description: { type: "string" },
              allergens: {
                type: "array",
                items: { type: "string" },
                description: "Standard allergener på norsk, f.eks. melk, gluten (hvete), egg, fisk, nøtter"
              },
              vegetarian: { type: "boolean" },
              vegan: { type: "boolean" },
              spicy: { type: "boolean" },
              notes: { type: "string" }
            },
            required: ["title"]
          }
        },
        pretty_text_nb: { type: "string", description: "Pen, kort norsk oppsummering for Slack" }
      },
      required: ["language", "items", "pretty_text_nb"]
    }
  };

  const todayNb = ["Søndag","Mandag","Tirsdag","Onsdag","Torsdag","Fredag","Lørdag"][new Date().getDay()];
  const system = `
  Du er en norsk menyredaktør (bokmål). Du får rotete kantinetekst (svorsk/engelsk/feilstaving).
  Oppgave:
  1) Finn dagens seksjon (prioriter "${todayNb}", men bruk skjønn om dato/ukedag mangler).
  2) «Gjett» intensjonen bak rare ord og oversett til korrekt norsk.
  3) Normaliser allergener (gluten -> gluten (hvete) hvis relevant).
  4) Returner struktur etter JSON-skjemaet. Ikke legg til ting som ikke står implisitt i teksten.
  5) Bruk norsk bokmål i all tekst.`.trim();

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: {
        type: "json_schema",
        json_schema: menuSchema
      },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Rå menytekst:\n${raw}\n\nReturner kun JSON.` }
      ],
      max_tokens: 800
    });

    const json = JSON.parse(resp.choices[0].message.content);

    // Lag enkel «pen tekst» fallback hvis tom
    const pretty = json.pretty_text_nb && json.pretty_text_nb.trim().length > 0
      ? json.pretty_text_nb
      : json.items.map(i => `• ${i.title}${i.allergens?.length ? ` (allergener: ${i.allergens.join(", ")})` : ""}`).join("\n");

    return { prettyText: pretty, data: json };
  } catch (err) {
    console.error("AI normalize error", err);
    return { prettyText: "", data: null };
  }
  
}



const getRandomPrompt = (menuText) => {
  const imagePrompts = [
    `A hyper-realistic, ultra-detailed, close-up photo shot of ${menuText} with a high-end DSLR, showcasing extreme texture and contrast. The subject is illuminated by a harsh, stylized flash, creating dramatic shadows and sharp highlights. The image feels tactile and immersive—every pore, fiber, or surface detail is visible. Shot with a shallow depth of field, background bokeh is creamy and minimal. Composition is unique and intentional—this is not just realism, it’s hyper-real, cinematic still life with a surreal edge.`,
    `Professional food photography, ${menuText}`
  ]
  return imagePrompts[Math.floor(Math.random() * imagePrompts.length)];
};

async function main() {
  console.info("I'm starting, hold on!");
  try {
    console.info('Fetching website...');
    const html = await fetchWebsite(websiteUrl);

    //const menuText = extractMenuForDay(html);
    //const menuTextAi = await extractMenuForDayWithAI(html);
    
    console.info('Extracting menu...');
    const { prettyText, data } = await extractAndNormalizeMenu(html);

    const randomPrompt = getRandomPrompt(prettyText)
    
    console.info('Generating image from text: ', prettyText);
    const imageUrl = await generateMenuImage(randomPrompt);

    console.info('Sending to Slack...');
    await sendToSlack(prettyText, imageUrl, randomPrompt);

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
