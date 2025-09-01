const axios = require('axios');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const OpenAI = require('openai');
const formidable = require('formidable');

// Verificar que la API key de OpenAI esté configurada
let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} else {
  console.error('❌ OPENAI_API_KEY no está configurada');
}

const DEFAULT_URL = 'https://juanulisespv.github.io/cv-es/';

// Cache temporal en memoria (para desarrollo sin Redis)
const tempCache = new Map();

// Función para cargar conversación desde almacenamiento externo
async function loadConversation(sessionId) {
  try {
    // Verificar si las variables de entorno están configuradas (Vercel usa KV_REST_API_*)
    const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    
    if (!redisUrl || !redisToken) {
      return tempCache.get(sessionId) || null;
    }

    // Upstash Redis
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({
      url: redisUrl,
      token: redisToken,
    });
    
    return await redis.get(`conversation:${sessionId}`);
    
  } catch (error) {
    console.log('Error cargando de Redis, usando cache temporal:', error.message);
    return tempCache.get(sessionId) || null;
  }
}

// Función para guardar conversación en almacenamiento externo
async function saveConversationToExternal(sessionId, conversationData) {
  try {
    // Verificar si las variables de entorno están configuradas (Vercel usa KV_REST_API_*)
    const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    
    if (!redisUrl || !redisToken) {
      // Guardar en cache temporal
      tempCache.set(sessionId, conversationData);
      
      console.log('💾 [CACHE TEMPORAL] Conversación guardada:', {
        sessionId,
        timestamp: new Date().toISOString(),
        totalMessages: conversationData.messages.length,
        ultimoMensaje: conversationData.messages[conversationData.messages.length - 1]?.content?.substring(0, 50) || 'N/A'
      });
      return true;
    }

    // Upstash Redis
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({
      url: redisUrl,
      token: redisToken,
    });
    
    await redis.set(`conversation:${sessionId}`, conversationData);
    await redis.sadd('conversation_sessions', sessionId);
    
    console.log('💾 [UPSTASH REDIS] Conversación guardada:', {
      sessionId,
      timestamp: new Date().toISOString(),
      totalMessages: conversationData.messages.length
    });
    
    return true;
  } catch (error) {
    console.error('Error guardando en Redis, usando fallback:', error.message);
    tempCache.set(sessionId, conversationData);
    return true;
  }
}

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
  // Configurar CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

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
      } catch (parseError) {
        res.status(400).json({ error: 'Error parseando JSON: ' + parseError.message });
        return;
      }
      await handleRequest(data, {}, res);
    });
  }
};

async function handleRequest(fields, files, res) {
  try {
    const pregunta = fields.pregunta || '';
    const sessionId = fields.sessionId || 'default-session';
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

    // Verificar que OpenAI esté configurado
    if (!openai || !process.env.OPENAI_API_KEY) {
      res.status(500).json({ error: 'OpenAI API Key no configurada en el servidor' });
      return;
    }

    // Intentar cargar conversación existente
    let conversation = await loadConversation(sessionId);
    
    // Si no existe, crear nueva conversación
    if (!conversation) {
      conversation = {
        sessionId,
        messages: [],
        lastActivity: Date.now(),
        createdAt: Date.now(),
        contextText: '',
        userAgent: req.headers['user-agent'] || 'unknown',
        totalInteractions: 0
      };
    }
    
    // Actualizar metadatos
    conversation.lastActivity = Date.now();
    conversation.totalInteractions = (conversation.totalInteractions || 0) + 1;

    let texto = '';
    if (url) {
      try {
        texto = await getTextFromUrl(url);
        conversation.contextText = texto;
      } catch {
        res.status(400).json({ error: 'No se pudo obtener el texto de la URL.' });
        return;
      }
    } else if (pdfBuffer) {
      texto = await getTextFromPdf(pdfBuffer);
      conversation.contextText = texto;
    } else {
      if (conversation.contextText) {
        texto = conversation.contextText;
      } else {
        try {
          texto = await getTextFromUrl(DEFAULT_URL);
          conversation.contextText = texto;
        } catch {
          res.status(400).json({ error: 'No se pudo obtener el texto de la URL por defecto.' });
          return;
        }
      }
    }

    // Agregar la pregunta del usuario al historial
    conversation.messages.push({
      role: 'user',
      content: pregunta,
      timestamp: Date.now()
    });

    // Construir el historial para el prompt
    let historialTexto = '';
    if (conversation.messages.length > 1) {
      const recentMessages = conversation.messages.slice(-8);
      historialTexto = '\n\nHistorial de conversación reciente:\n';
      for (let i = 0; i < recentMessages.length - 1; i += 2) {
        if (recentMessages[i] && recentMessages[i + 1]) {
          historialTexto += `Usuario: ${recentMessages[i].content}\n`;
          historialTexto += `Uli: ${recentMessages[i + 1].content}\n`;
        }
      }
      historialTexto += '\n';
    }

    // Construir prompt con memoria
    let prompt = `Eres Juan Ulises (Uli), un programador full stack y experto en marketing de Vitoria. Responde en primera persona usando la información del texto extraído y mantén coherencia con el historial de conversación previo. 


- Recuerda lo que se ha hablado antes en esta conversación
- Si el usuario hace referencia a algo mencionado anteriormente, reconócelo
- Mantén un tono consistente y natural como si fuera una conversación continua
- La respuesta ideal tiene menos de 17 palabras, pero puedes usar hasta un máximo de 50 palabras si es necesario
- Usa un tono amable, gracioso y desenfadado, incluyendo chistes o comentarios divertidos cuando sea posible

Información de referencia sobre Uli:
${texto}${historialTexto}
Pregunta actual: ${pregunta}
Respuesta de Uli:`;

    const completion = await openai.completions.create({
      model: 'gpt-3.5-turbo-instruct',
      prompt,
      max_tokens: 512,
      temperature: 0.7,
    });
    const respuesta = completion.choices[0].text.trim();

    // Agregar la respuesta al historial
    conversation.messages.push({
      role: 'assistant',
      content: respuesta,
      timestamp: Date.now()
    });

    // Guardar conversación actualizada inmediatamente después de cada mensaje
    try {
      await saveConversationToExternal(sessionId, conversation);
    } catch (saveError) {
      console.error('Error guardando, pero continuando:', saveError.message);
    }

    res.status(200).json({ respuesta });
  } catch (err) {
    console.error('Error en /api/consultar:', err);
    let errorMsg = 'Error procesando la consulta: ' + err.message;
    res.status(500).json({ error: errorMsg });
  }
}
