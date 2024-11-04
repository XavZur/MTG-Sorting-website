import express from 'express';
import multer from 'multer';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createObjectCsvWriter } from 'csv-writer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

const uploadsDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
}

const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));


app.post('/upload', upload.single('deckFile'), async (req, res) => {
  try {
    const filePath = path.join(__dirname, req.file.path);
    const fileContent = fs.readFileSync(filePath, 'utf-8');

    const deck = parseDeckFile(fileContent);

    if (deck.length === 0) {
      throw new Error('Deck file is empty or improperly formatted.');
    }

    const detailedDeck = await fetchCardDetails(deck);

    if (detailedDeck.length === 0) {
      throw new Error('No valid card data found.');
    }

    const organizedDeck = organizeByType(detailedDeck);

    const csvFilename = `deck_${Date.now()}.csv`;
    const csvPath = path.join(__dirname, 'output', csvFilename);
    await generateCSV(organizedDeck, csvPath);

    fs.unlinkSync(filePath);

    res.json({ filename: csvFilename, detailedDeck });
  } catch (error) {
    console.error('Error processing the deck:', error);
    res.status(500).send(error.message);
  }
});

app.get('/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'output', filename);

  if (fs.existsSync(filePath)) {
    res.download(filePath, 'deck.csv', (err) => {
      if (err) {
        console.error('Error downloading the file:', err);
        res.status(500).send('Internal Server Error');
      }
    });
  } else {
    res.status(404).send('File not found');
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});


function parseDeckFile(content) {
  const lines = content.split('\n').map(line => line.trim()).filter(line => line !== '');
  const deck = lines.map(line => {
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (match) {
      return { count: parseInt(match[1], 10), name: match[2] };
    } else {
      console.warn(`Skipping invalid line: "${line}"`);
      return null;
    }
  }).filter(entry => entry !== null);
  return deck;
}

async function fetchCardDetails(deck) {
  const detailedDeck = [];
  const uniqueCards = {};
  let totalUsd = 0;
  let totalCad = 0;

  deck.forEach(card => {
    const name = card.name;
    if (uniqueCards[name]) {
      uniqueCards[name] += card.count;
    } else {
      uniqueCards[name] = card.count;
    }
  });

  const cardNames = Object.keys(uniqueCards);
  console.log(`Fetching details for ${cardNames.length} unique cards.`);

  let usdToCadRate = 1;
  try {
    const exchangeResponse = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    const exchangeData = await exchangeResponse.json();
    usdToCadRate = exchangeData.rates.CAD || 1;
  } catch (error) {
    console.error('Error fetching exchange rate:', error);
  }

  for (const name of cardNames) {
    try {
      const response = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch card: ${name} (Status: ${response.status})`);
      }
      const data = await response.json();

      const usdPrice = parseFloat(data.prices.usd || 0);
      const cadPrice = parseFloat((usdPrice * usdToCadRate).toFixed(2));

      totalUsd += usdPrice * uniqueCards[name];
      totalCad += cadPrice * uniqueCards[name];

      detailedDeck.push({
        name: data.name,
        count: uniqueCards[name],
        type: parseCardType(data.type_line),
        image_uri: data.image_uris ? data.image_uris.normal : 'N/A',
        mana_cost: data.mana_cost,
        usd_price: usdPrice,
        cad_price: cadPrice,
        total_cad: totalCad,
        total_usd: totalUsd,
      });

      await delay(50);
    } catch (error) {
      console.error(`Error fetching card "${name}":`, error.message);
    }
  }

  return detailedDeck;
}

function parseCardType(typeLine) {
  const types = ['Artifact', 'Creature', 'Enchantment', 'Instant', 'Land', 'Planeswalker', 'Sorcery'];
  for (const type of types) {
    if (typeLine.includes(type)) {
      return type;
    }
  }
  return 'Other';
}

function organizeByType(deck) {
  if (!Array.isArray(deck)) {
    throw new TypeError('Expected an array for the deck but got ' + typeof deck);
  }

  const organized = {};

  deck.forEach(card => {
    const type = card.type;
    if (!organized[type]) {
      organized[type] = [];
    }
    organized[type].push({
      name: card.name,
      count: card.count,
      image_uri: card.image_uri,
      mana_cost: card.mana_cost, 
    });
  });

  return organized;
}

async function generateCSV(organizedDeck, filePath) {
  const csvWriter = createObjectCsvWriter({
    path: filePath,
    header: [
      { id: 'type', title: 'Type' },
      { id: 'count', title: 'Count' },
      { id: 'name', title: 'Name' },
      { id: 'mana_cost', title: 'Mana Cost' }, 
      { id: 'image_uri', title: 'Image URL' }
    ]
  });

  const records = [];

  for (const [type, cards] of Object.entries(organizedDeck)) {
    cards.forEach(card => {
      records.push({
        type: type,
        count: card.count,
        name: card.name,
        mana_cost: card.mana_cost, 
        image_uri: card.image_uri
      });
    });
  }

  await csvWriter.writeRecords(records);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
