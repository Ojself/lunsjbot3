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

function formatPromptBlock(prompt) {
  if (!prompt) return null;

  // Slack section text limit is 3000 chars; keep a little buffer.
  const maxLen = 2900;
  const text = prompt.length > maxLen
    ? `${prompt.slice(0, maxLen)}\n…(truncated)`
    : prompt;

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Prompt*\n\`\`\`\n${text}\n\`\`\``,
    },
  };
}

async function postToSlackApi({ blocks, text, threadTs }) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL;
  if (!token || !channel) return null;

  const payload = {
    channel,
    text,
    blocks,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  };

  const resp = await axios.post('https://slack.com/api/chat.postMessage', payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });

  if (!resp.data?.ok) {
    throw new Error(`Slack API error: ${resp.data?.error || 'unknown_error'}`);
  }

  return resp.data;
}

async function sendToSlack(menuText, imageUrl, prompt) {
  const webhook = new IncomingWebhook(process.env.SLACK_WEBHOOK_URL);
  const promptBlock = formatPromptBlock(prompt);
  const mainBlocks = [
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
  ];

  try {
    const mainText = `Dagens meny hos Smaus:\n${menuText}`;
    const apiResp = await postToSlackApi({ blocks: mainBlocks, text: mainText });

    if (apiResp && promptBlock) {
      await postToSlackApi({
        blocks: [promptBlock],
        text: 'Prompt',
        threadTs: apiResp.ts,
      });
      return;
    }

    await webhook.send({ blocks: mainBlocks });

    if (promptBlock) {
      // Fallback: no thread support via incoming webhook
      await webhook.send({ blocks: [promptBlock] });
    }
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
    `Cinematic fine-dining photograph of ${menuText}, shot on a full-frame camera with a 50mm f/1.2 lens. Low-key lighting with rich shadows and subtle rim light detailing the edges of the dish. Deep, velvety color grading, inspired by Michelin-star plating photography. Texture-rich macro detail with a moody, intimate dining atmosphere.`,
    `Bright editorial food photography of ${menuText}, styled for a high-end culinary magazine. Natural sunlight from a window creates soft gradients and gentle shadows. Props are minimalist: linen napkins, matte ceramic dishes, seasonal accents. Shot with a 35mm lens for an airy, lifestyle feel—clean, fresh, and inviting.`,
    `Dynamic splash-art studio shot of ${menuText}, frozen mid-motion with high-speed flash. Liquids, crumbs, or ingredients suspended dramatically in the air. Hyper-crisp detail, glossy highlights, and commercial-advertising polish. Background is pure gradient studio color for maximum contrast and visual impact.`,
    `Rustic, farm-to-table style photo of ${menuText} on weathered wood surfaces. Soft warm light like golden-hour sun, earthy tones, and natural textures. Includes organic props like herbs, grain sacks, or vegetables. Shallow depth of field and subtle film grain for an artisanal, wholesome feel.`,
    `Extreme macro photography of ${menuText}, focusing on abstract textures and micro-details. 5:1 magnification, razor-thin depth of field, and controlled studio lighting. The food becomes sculptural and surreal—emphasizing pattern, moisture, crystallization, and structure like scientific photography with artistic flair.`,
    `Clean, glossy commercial product photograph of ${menuText} styled for packaging. Perfect symmetry, immaculate styling, and ultra-sharp definition. Background is seamless white or color-matched. Lighting is even, diffused, and controlled. Every element appears intentional, polished, and ready for print.`,
    `Soft, dreamy pastel-toned food photo of ${menuText}. Backlit with gentle diffusion, creating a glowing halo around the dish. Props include soft linens, pastel ceramics, and airy backgrounds. Atmosphere feels delicate, ethereal, and almost whimsical.`,
    `Dark-academia inspired gourmet photo of ${menuText} with deep brown, brass, and parchment tones. Lit like an old oil painting with directional Rembrandt-style lighting. Heavy shadows, rich textures, and dramatic vignetting create a moody, scholarly atmosphere.`,
    `Authentic street-food documentary-style photo of ${menuText}, shot handheld with a 28mm lens. Ambient natural lighting, candid composition, real textures, and environmental background elements (grills, steam, signage). Raw, vibrant, and full of life.`,
    `Modernist cuisine presentation of ${menuText}, plated with avant-garde precision. Minimalist composition, mirror-like surfaces, microgreens, geometric sauces, and molecular-gastronomy elements. Shot with clinical studio lighting for pristine detail and futuristic aesthetic.`,
    //`Professional food photography, ${menuText}`
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
    console.log(imageUrl)
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
