const axios = require('axios');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const OpenAI = require('openai');
const formidable = require('formidable');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DEFAULT_URL = 'https://juanulisespv.github.io/cv-es/';

// Cache temporal en memoria (para desarrollo sin Redis)
const tempCache = new Map();

// Función para cargar conversación desde almacenamiento externo
async function loadConversation(sessionId) {
  try {
    // Verificar si las variables de entorno están configuradas
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
      console.log('Redis no configurado, usando cache temporal');
      return tempCache.get(sessionId) || null;
    }

    // Upstash Redis
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
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
    // Verificar si las variables de entorno están configuradas
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
      // Guardar en cache temporal
      tempCache.set(sessionId, conversationData);
      
      console.log('💾 [CACHE TEMPORAL] Conversación guardada:', {
        sessionId,
        timestamp: new Date().toISOString(),
        totalMessages: conversationData.messages.length,
        lastActivity: new Date(conversationData.lastActivity).toISOString(),
        ultimoMensaje: conversationData.messages[conversationData.messages.length - 1]?.content || 'N/A'
      });
      return true;
    }

    // Upstash Redis
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    
    await redis.set(`conversation:${sessionId}`, conversationData);
    
    // También mantener un índice de todas las conversaciones
    await redis.sadd('conversation_sessions', sessionId);
    
    // Log para debug
    console.log('💾 [UPSTASH REDIS] Conversación guardada:', {
      sessionId,
      timestamp: new Date().toISOString(),
      totalMessages: conversationData.messages.length,
      lastActivity: new Date(conversationData.lastActivity).toISOString()
    });
    
    return true;
  } catch (error) {
    console.error('Error guardando en Redis, usando fallback:', error.message);
    
    // Fallback: guardar en cache temporal
    tempCache.set(sessionId, conversationData);
    
    // Registrar en logs con más detalle
    console.log('💾 [FALLBACK] Conversación guardada:', {
      sessionId,
      timestamp: new Date().toISOString(),
      totalMessages: conversationData.messages.length,
      lastActivity: new Date(conversationData.lastActivity).toISOString(),
      ultimoMensajeUsuario: conversationData.messages.filter(m => m.role === 'user').pop()?.content || 'N/A',
      ultimaRespuesta: conversationData.messages.filter(m => m.role === 'assistant').pop()?.content || 'N/A'
    });
    
    return true; // Consideramos exitoso el fallback
  }
}

// Guardar conversaciones en archivo
function saveConversations() {
  try {
    const conversationsObj = Object.fromEntries(conversations);
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(conversationsObj, null, 2));
  } catch (error) {
    console.error('Error guardando conversaciones:', error.message);
  }
}

// Cargar conversaciones al iniciar
loadConversations();

// Guardar conversaciones cada 2 minutos
setInterval(saveConversations, 2 * 60 * 1000);

// Limpiar conversaciones viejas cada 30 minutos
setInterval(() => {
  const now = Date.now();
  let hasChanges = false;
  
  for (const [sessionId, data] of conversations.entries()) {
    if (now - data.lastActivity > 24 * 60 * 60 * 1000) { // 24 horas
      conversations.delete(sessionId);
      hasChanges = true;
    }
  }
  
  if (hasChanges) {
    saveConversations();
  }
}, 30 * 60 * 1000);

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

    // Intentar cargar conversación existente desde almacenamiento externo
    let conversation = await loadConversation(sessionId);
    
    // Si no existe o si es una sesión nueva, crear nueva conversación
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
        conversation.contextText = texto; // Actualizar contexto si hay nueva URL
      } catch {
        res.status(400).json({ error: 'No se pudo obtener el texto de la URL.' });
        return;
      }
    } else if (pdfBuffer) {
      texto = await getTextFromPdf(pdfBuffer);
      conversation.contextText = texto; // Actualizar contexto si hay nuevo PDF
    } else {
      // Usar contexto existente o cargar el por defecto
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
      // Tomar las últimas 8 interacciones para no hacer el prompt demasiado largo
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

IMPORTANTE: 
- Recuerda lo que se ha hablado antes en esta conversación
- Si el usuario hace referencia a algo mencionado anteriormente, reconócelo
- Mantén un tono consistente y natural como si fuera una conversación continua
- La respuesta ideal tiene menos de 17 palabras, pero puedes usar hasta un máximo de 50 palabras si es necesario
- Usa un tono profesional, amable, gracioso y desenfadado, incluyendo chistes o comentarios divertidos cuando sea posible

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
      // No fallar la respuesta si hay error guardando
      console.error('Error guardando, pero continuando:', saveError.message);
    }

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
