module.exports = async (req, res) => {
  // Solo POST permitido
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  // Cabeceras para iframe (ojo, no usar X-Frame-Options: ALLOWALL porque no es válido)
  res.removeHeader('X-Frame-Options');
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://mac-os-classic.vercel.app"
  );

  // Aquí tu lógica para el POST (ejemplo simple)
  res.status(200).json({ message: 'POST recibido' });
};




const axios = require('axios');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const OpenAI = require('openai');
const formidable = require('formidable');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DEFAULT_URL = 'https://juanulisespv.github.io/CV/';

// Helper para extraer texto de una URL
async function getTextFromUrl(url) {
  const response = await axios.get(url);
  const $ = cheerio.load(response.data);
  return $('body').text().replace(/\s+/g, ' ').trim().substring(0, 8000);
}

// Helper para extraer texto de un PDF (buffer)
async function getTextFromPdf(buffer) {
  const data = await pdfParse(buffer);
  return data.text.substring(0, 8000);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  // Parsear form-data (PDF) o JSON
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    // Usar formidable para parsear form-data
    const form = new formidable.IncomingForm();
    form.parse(req, async (err, fields, files) => {
      if (err) {
        res.status(400).json({ error: 'Error al procesar el formulario.' });
        return;
      }
      await handleRequest(fields, files, res);
    });
  } else {
    // JSON
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let data = {};
      try {
        data = JSON.parse(body);
      } catch {}
      await handleRequest(data, {}, res);
    });
  }
};

async function handleRequest(fields, files, res) {
  try {
    const pregunta = fields.pregunta || '';
    const url = fields.url || '';
    let pdfBuffer = null;
    if (files.pdf && files.pdf.filepath) {
      const fs = require('fs');
      pdfBuffer = fs.readFileSync(files.pdf.filepath);
    }

    if (!pregunta) {
      res.status(400).json({ error: 'Falta la pregunta.' });
      return;
    }

    let texto = '';
    if (url) {
      try {
        texto = await getTextFromUrl(url);
      } catch {
        res.status(400).json({ error: 'No se pudo obtener el texto de la URL.' });
        return;
      }
    } else if (pdfBuffer) {
      texto = await getTextFromPdf(pdfBuffer);
    } else {
      try {
        texto = await getTextFromUrl(DEFAULT_URL);
      } catch {
        res.status(400).json({ error: 'No se pudo obtener el texto de la URL por defecto.' });
        return;
      }
    }

    // Construir prompt
    let prompt = `Responde la siguiente pregunta usando la información del texto extraído del PDF o de la web proporcionada. La respuesta ideal tiene menos de 17 palabras, pero puedes usar hasta un máximo de 50 palabras si es necesario. Usa un tono amable, gracioso y desenfadado, incluyendo chistes o comentarios divertidos cuando sea posible.\n\nTexto:\n${texto}\n\nPregunta: ${pregunta}\nRespuesta:`;

    const completion = await openai.completions.create({
      model: 'gpt-3.5-turbo-instruct',
      prompt,
      max_tokens: 512,
      temperature: 0.7,
    });
    const respuesta = completion.choices[0].text.trim();

    res.status(200).json({ respuesta });
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
}
