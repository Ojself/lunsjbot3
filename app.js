require('dotenv').config();
const cheerio = require('cheerio');
const cron = require('node-cron');
const { IncomingWebhook } = require('@slack/webhook');
const OpenAI = require('openai');
const puppeteer = require('puppeteer');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });



  const fetchWebsite = async (url) => {
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox'], // Required in many server environments
    });
  
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle2' });
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
  console.log(menuElement.html())
  return menuElement.html()
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
  const plainText = cheerio.load(html).text();
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  const prompt = `Extract ${today}'s cafeteria menu from the text below:\n\n${plainText}`;

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


async function generateMenuImage(menuText) {
  try {
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: `Create a visually appealing image with no text that represents the following cafeteria menu:\n${menuText}`,
      n: 1, 
      size: '1024x1024',
    });
    return response.data[0]?.url;
  } catch (error) {
    console.error('Error generating image with AI:', error);
  }
}
  
async function sendToSlack(menuText, imageUrl) {
const webhook = new IncomingWebhook(process.env.SLACK_WEBHOOK_URL);
  try {
    await webhook.send({
      text: "Dagens meny hos Smaus",
      attachments: [
        {
          text: menuText,
          image_url: imageUrl, 
        },
      ],
    });
  } catch (error) {
    console.error('Error sending message to Slack:', error);
  }
}


async function main() {
  const websiteUrl = 'https://tullin.munu.shop/meny'; 
  try {

    const html = await fetchWebsite(websiteUrl);
    const menuText = extractMenuForDay(html);
    
    //const menuText = await extractMenuWithAI(extractedHtml); 
    
    const imageUrl = await generateMenuImage(menuText); 
  
    await sendToSlack(menuText, imageUrl); 
    console.log("I'm done, bye!");    
    process.exit(0); 
  }
  catch (error) {
    console.error('Error: ', error);
    process.exit(1)
  }

}

main();

/* cron.schedule('0 10 * * 1-5', () => {
  main();
}); */
