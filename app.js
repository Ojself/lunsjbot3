require("dotenv").config();
const cheerio = require("cheerio");
// const cron = require('node-cron');
const { IncomingWebhook } = require("@slack/webhook");
const OpenAI = require("openai");
const puppeteer = require("puppeteer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const axios = require("axios");
const crypto = require("node:crypto");
const path = require("node:path");
const sharp = require("sharp");

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
	forcePathStyle: true,
});

async function uploadToR2(imageData, fileName) {
	try {
		let buffer;

		if (imageData.startsWith("data:")) {
			// Handle base64 data URI
			const base64Data = imageData.split(",")[1];
			buffer = Buffer.from(base64Data, "base64");
		} else {
			// Handle image URL
			const response = await axios.get(imageData, {
				responseType: "arraybuffer",
			});
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
			ContentType: "image/png",
		});
		await s3.send(command);

		const publicUrl = `https://${process.env.R2_PUBLIC_DOMAIN}/${objectKey}`;

		return publicUrl;
	} catch (error) {
		console.error("Error uploading to R2:", error);
		throw error;
	}
}

const fetchWebsite = async (url) => {
	const browser = await puppeteer.launch({
		headless: true,
		args: ["--no-sandbox"],
	});

	try {
		const page = await browser.newPage();

		await page.goto(url);
		await page.waitForNetworkIdle();

		const content = await page.content();
		return content;
	} catch (error) {
		console.error("Error fetching website with Puppeteer:", error);
		throw error;
	} finally {
		await browser.close();
	}
};

async function generateMenuImage(prompt) {
	try {
		const base64Photo = (await sharp(path.join(__dirname, "flink_utvikler.jpeg"))
			.resize(1024, 1024, { fit: "cover" })
			.jpeg()
			.toBuffer()).toString("base64");

		const response = await openai.responses.create({
			model: "gpt-4o",
			input: [
				{
					role: "user",
					content: [
						{
							type: "input_image",
							image_url: `data:image/jpeg;base64,${base64Photo}`,
						},
						{
							type: "input_text",
							text: `Generate a photorealistic image of the person in this photo. ${prompt} Preserve their exact facial features, hair, and overall appearance faithfully.`,
						},
					],
				},
			],
			tools: [{ type: "image_generation" }],
		});

		console.info("Full response.output:", JSON.stringify(response.output, null, 2));
		const imageCall = response.output.find((o) => o.type === "image_generation_call");
		console.info("image_generation_call output:", JSON.stringify(imageCall, null, 2));
		const b64_json = imageCall?.result;

		if (b64_json) {
			const imageUrl = `data:image/png;base64,${b64_json}`;
			const uploadedUrl = await uploadToR2(imageUrl, "menu-image.png");
			console.info("Uploaded image URL:", uploadedUrl);
			return uploadedUrl;
		} else {
			throw new Error("Failed to generate image URL");
		}
	} catch (error) {
		console.error("Error generating image with AI:", error);
		throw error;
	}
}

function formatPromptBlock(prompt) {
	if (!prompt) return null;

	// Slack section text limit is 3000 chars; keep a little buffer.
	const maxLen = 2900;
	const text =
		prompt.length > maxLen
			? `${prompt.slice(0, maxLen)}\n…(truncated)`
			: prompt;

	return {
		type: "section",
		text: {
			type: "mrkdwn",
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
		unfurl_links: false,
		unfurl_media: false,
		...(threadTs ? { thread_ts: threadTs } : {}),
	};

	const resp = await axios.post(
		"https://slack.com/api/chat.postMessage",
		payload,
		{
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json; charset=utf-8",
			},
		},
	);

	if (!resp.data?.ok) {
		throw new Error(`Slack API error: ${resp.data?.error || "unknown_error"}`);
	}

	return resp.data;
}

async function sendToSlack(menuText, imageUrl, prompt) {
	const webhook = new IncomingWebhook(process.env.SLACK_WEBHOOK_URL);
	const promptBlock = formatPromptBlock(prompt);
	const mainBlocks = [
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
		...(imageUrl
			? [
				{
					type: "image",
					image_url: imageUrl,
					alt_text: "Cafeteria menu image",
				},
			]
			: []),
		{
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: "Lunsjbotten trenger en ny utvikler, <mailto:tormod.flesjo@gmail.com|ta kontakt> innen 15. mai.",
				},
			],
		},
	];

	try {
		const mainText = `Dagens meny hos Smaus:\n${menuText}`;
		const apiResp = await postToSlackApi({
			blocks: mainBlocks,
			text: mainText,
		});

		if (apiResp && promptBlock) {
			await postToSlackApi({
				blocks: [promptBlock],
				text: "Prompt",
				threadTs: apiResp.ts,
			});
			return;
		}

		await webhook.send({
			blocks: mainBlocks,
			unfurl_links: false,
			unfurl_media: false,
		});

		if (promptBlock) {
			console.warn(
				"Prompt not posted in thread because SLACK_BOT_TOKEN/SLACK_CHANNEL are missing.",
			);
		}
	} catch (error) {
		console.error("Error sending message to Slack:", error);
	}
}

async function extractAndNormalizeMenu(html) {
	const $ = cheerio.load(html);
	const raw = $(".static-container").text();

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
							title: {
								type: "string",
								description: "Kort norsk navn på retten, rettet for stavefeil",
							},
							description: { type: "string" },
							allergens: {
								type: "array",
								items: { type: "string" },
								description:
									"Standard allergener på norsk, f.eks. melk, gluten (hvete), egg, fisk, nøtter",
							},
							vegetarian: { type: "boolean" },
							vegan: { type: "boolean" },
							spicy: { type: "boolean" },
							notes: { type: "string" },
						},
						required: ["title"],
					},
				},
				pretty_text_nb: {
					type: "string",
					description: "Pen, kort norsk oppsummering for Slack",
				},
			},
			required: ["language", "items", "pretty_text_nb"],
		},
	};

	const todayNb = [
		"Søndag",
		"Mandag",
		"Tirsdag",
		"Onsdag",
		"Torsdag",
		"Fredag",
		"Lørdag",
	][new Date().getDay()];
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
				json_schema: menuSchema,
			},
			messages: [
				{ role: "system", content: system },
				{
					role: "user",
					content: `Rå menytekst:\n${raw}\n\nReturner kun JSON.`,
				},
			],
			max_tokens: 800,
		});

		const json = JSON.parse(resp.choices[0].message.content);

		// Lag enkel «pen tekst» fallback hvis tom
		const pretty =
			json.pretty_text_nb && json.pretty_text_nb.trim().length > 0
				? json.pretty_text_nb
				: json.items
						.map(
							(i) =>
								`• ${i.title}${i.allergens?.length ? ` (allergener: ${i.allergens.join(", ")})` : ""}`,
						)
						.join("\n");

		return { prettyText: pretty, data: json };
	} catch (err) {
		console.error("AI normalize error", err);
		return { prettyText: "", data: null };
	}
}

const getRandomPrompt = (dishTitles) => {
	const imagePrompts = [
		`The person in the reference photo is sitting at a cozy restaurant table, happily eating ${dishTitles}. Warm candlelight, rustic wooden table, casual dining atmosphere. Candid, natural moment. Photorealistic, shot on 35mm f/1.8.`,
		`The person in the reference photo is at a bright office canteen, mid-bite into ${dishTitles}. Cheerful expression, modern cafeteria setting with other diners blurred in the background. Natural overhead lighting. Photorealistic, documentary style.`,
		`The person in the reference photo is enjoying a fine-dining lunch of ${dishTitles}. White tablecloth, elegant plating, soft window light from the side. Sophisticated and relaxed atmosphere. Photorealistic, shot on 50mm f/1.2.`,
		`The person in the reference photo is eating ${dishTitles} outdoors at a sunny terrace café. Dappled sunlight, bistro chairs, plants in the background. Relaxed, summery mood. Photorealistic, lifestyle photography.`,
		`The person in the reference photo is dramatically presenting a plate of ${dishTitles} to the camera with theatrical enthusiasm, like a TV chef. Studio lighting, colorful background. Fun, bold, cinematic.`,
		`The person in the reference photo is eating ${dishTitles} at a cozy home kitchen table. Morning light through a window, casual clothes, comfortable and intimate atmosphere. Photorealistic, warm tones.`,
		`The person in the reference photo is at a lively food market, holding and tasting ${dishTitles}. Busy, vibrant background with stalls and people. Handheld camera feel, travel documentary style.`,
	];
	return imagePrompts[Math.floor(Math.random() * imagePrompts.length)];
};

async function main() {
	console.info("I'm starting, hold on!");
	try {
		console.info("Fetching website...");
		const html = await fetchWebsite(websiteUrl);

		//const menuText = extractMenuForDay(html);
		//const menuTextAi = await extractMenuForDayWithAI(html);

		console.info("Extracting menu...");
		const { prettyText, data } = await extractAndNormalizeMenu(html);

		const dishTitles =
			data?.items?.map((i) => i.title).join(", ") || prettyText;
		const randomPrompt = getRandomPrompt(dishTitles);

		console.info("Generating image from text: ", prettyText);
		const imageUrl = await generateMenuImage(randomPrompt);

		console.info("Sending to Slack...");
		console.log(imageUrl);
		await sendToSlack(prettyText, imageUrl, randomPrompt);

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
