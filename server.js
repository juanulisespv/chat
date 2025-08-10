require('dotenv').config();
// Backend Express para chat con PDF y OpenAI
const express = require('express');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const OpenAI = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(fileUpload());
app.use(express.json());

// Configura tu API Key de OpenAI aquí o usa variables de entorno
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'TU_API_KEY_AQUI';
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Historial de conversación por sesión
const HISTORIAL_PATH = './historial.json';
let sesiones = {};

// URL por defecto si no se recibe PDF ni url
const DEFAULT_URL = 'https://juanulisespv.github.io/CV/';

// Cargar historial desde archivo si existe
if (fs.existsSync(HISTORIAL_PATH)) {
  try {
    sesiones = JSON.parse(fs.readFileSync(HISTORIAL_PATH, 'utf8'));
  } catch (e) {
    console.error('No se pudo cargar el historial:', e);
    sesiones = {};
  }
}

app.post('/api/consultar', async (req, res) => {
  try {
    const sessionId = req.body.sessionId;
    if (!sessionId) {
      return res.status(400).json({ error: 'Falta el sessionId.' });
    }
    const pregunta = req.body.pregunta;
    if (!pregunta) {
      return res.status(400).json({ error: 'Falta la pregunta.' });
    }

    let texto = '';
    // Si se recibe una URL, usar el texto de la web
    if (req.body.url) {
      try {
        const response = await axios.get(req.body.url);
        const $ = cheerio.load(response.data);
        texto = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 8000);
      } catch (e) {
        return res.status(400).json({ error: 'No se pudo obtener el texto de la URL.' });
      }
    } else if (req.files && req.files.pdf) {
      // Si no, usar el PDF
      const pdfBuffer = req.files.pdf.data;
      const data = await pdfParse(pdfBuffer);
      texto = data.text.substring(0, 8000); // Limitar tamaño para OpenAI
    } else {
      // Si no hay PDF ni url, usar la URL por defecto
      try {
        const response = await axios.get(DEFAULT_URL);
        const $ = cheerio.load(response.data);
        texto = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 8000);
      } catch (e) {
        return res.status(400).json({ error: 'No se pudo obtener el texto de la URL por defecto.' });
      }
    }


    // Inicializar historial si no existe
    if (!sesiones[sessionId]) {
      sesiones[sessionId] = [];
    }

    // Agregar pregunta al historial
    sesiones[sessionId].push({ role: 'user', content: pregunta });

    // Construir prompt SOLO con la pregunta actual, pidiendo tono amable, gracioso, desenfadado, con chistes y respuesta ideal <25 palabras (máx 50)
    let prompt = `Responde la siguiente pregunta usando la información del texto extraído del PDF o de la web proporcionada. La respuesta ideal tiene menos de 25 palabras, pero puedes usar hasta un máximo de 50 palabras si es necesario. Usa un tono amable, gracioso y desenfadado, incluyendo chistes o comentarios divertidos cuando sea posible.\n\nTexto:\n${texto}\n\nPregunta: ${pregunta}\nRespuesta:`;

    const completion = await openai.completions.create({
      model: 'gpt-3.5-turbo-instruct',
      prompt,
      max_tokens: 512,
      temperature: 0.2,
    });
    const respuesta = completion.choices[0].text.trim();

    // Agregar respuesta al historial
    sesiones[sessionId].push({ role: 'assistant', content: respuesta });

    // Guardar historial en archivo
    try {
      fs.writeFileSync(HISTORIAL_PATH, JSON.stringify(sesiones, null, 2), 'utf8');
    } catch (e) {
      console.error('No se pudo guardar el historial:', e);
    }

    res.json({ respuesta });
  } catch (err) {
    console.error('Error en /api/consultar:', err);
    let errorMsg = 'Error procesando la consulta.';
    if (err.response && err.response.data) {
      errorMsg = err.response.data.error?.message || JSON.stringify(err.response.data);
    } else if (err.message) {
      errorMsg = err.message;
    }
    res.status(500).json({ error: errorMsg });
  }
});

// Servir frontend si es necesario
app.use(express.static('.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
