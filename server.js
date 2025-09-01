require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const OpenAI = require('openai');
const formidable = require('formidable');

const app = express();
const PORT = 3000;

// Verificar que la API key de OpenAI esté configurada
let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log('✅ OpenAI API Key configurada correctamente');
} else {
  console.error('❌ OPENAI_API_KEY no está configurada');
}

// Configurar Redis solo si está disponible y funcional
let redis = null;
console.log('⚠️  Usando memoria temporal para máxima velocidad (Redis deshabilitado para desarrollo local)');

// Cache temporal en memoria para conversaciones
const tempCache = new Map();

// Buffer para guardar de forma diferida
const saveBuffer = new Map();
let saveTimer = null;

// Funciones para manejar el almacenamiento
async function loadConversation(sessionId) {
  try {
    // Primero buscar en cache temporal (más rápido)
    if (tempCache.has(sessionId)) {
      return tempCache.get(sessionId);
    }
    
    // Si no está en cache, buscar en Redis
    if (redis) {
      const data = await redis.get(`conversation:${sessionId}`);
      if (data) {
        // Cargar en cache temporal para acceso rápido
        tempCache.set(sessionId, data);
        return data;
      }
    }
    return null;
  } catch (error) {
    console.log('Error cargando de Redis, usando cache temporal:', error.message);
    return tempCache.get(sessionId) || null;
  }
}

// Guardar inmediatamente en cache temporal, y en Redis de forma diferida
async function saveConversation(sessionId, conversationData) {
  // Guardar inmediatamente en memoria (rápido)
  tempCache.set(sessionId, conversationData);
  
  // Programar guardado en Redis (diferido para no bloquear)
  if (redis) {
    saveBuffer.set(sessionId, conversationData);
    
    // Cancelar timer anterior si existe
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    
    // Guardar en Redis después de 5 segundos de inactividad
    saveTimer = setTimeout(async () => {
      try {
        console.log(`💾 [BATCH] Guardando ${saveBuffer.size} conversaciones en Redis...`);
        
        for (const [id, data] of saveBuffer.entries()) {
          await redis.set(`conversation:${id}`, data);
          await redis.sadd('conversation_sessions', id);
        }
        
        console.log(`✅ [BATCH] ${saveBuffer.size} conversaciones guardadas en Redis`);
        saveBuffer.clear();
      } catch (error) {
        console.error('Error en guardado batch:', error.message);
      }
    }, 5000); // 5 segundos de espera
  }
  
  return true;
}

async function getAllConversations() {
  try {
    if (redis) {
      const sessions = await redis.smembers('conversation_sessions');
      const conversaciones = [];
      
      for (const sessionId of sessions) {
        // Buscar primero en cache temporal
        let conversation = tempCache.get(sessionId);
        
        // Si no está en cache, buscar en Redis
        if (!conversation) {
          conversation = await redis.get(`conversation:${sessionId}`);
        }
        
        if (conversation) {
          conversaciones.push({
            sessionId,
            createdAt: new Date(conversation.createdAt).toLocaleString('es-ES'),
            lastActivity: new Date(conversation.lastActivity).toLocaleString('es-ES'),
            totalMessages: conversation.messages.length,
            totalInteractions: conversation.totalInteractions,
            preview: conversation.messages.length > 0 
              ? conversation.messages[0].content.substring(0, 100) + '...'
              : 'Sin mensajes'
          });
        }
      }
      return conversaciones;
    } else {
      const conversaciones = [];
      for (const [sessionId, conversation] of tempCache.entries()) {
        conversaciones.push({
          sessionId,
          createdAt: new Date(conversation.createdAt).toLocaleString('es-ES'),
          lastActivity: new Date(conversation.lastActivity).toLocaleString('es-ES'),
          totalMessages: conversation.messages.length,
          totalInteractions: conversation.totalInteractions,
          preview: conversation.messages.length > 0 
            ? conversation.messages[0].content.substring(0, 100) + '...'
            : 'Sin mensajes'
        });
      }
      return conversaciones;
    }
  } catch (error) {
    console.error('Error obteniendo conversaciones:', error);
    return [];
  }
}

// Middleware
app.use(express.static('.'));
app.use(express.json());

// Endpoint principal del chat
app.post('/api/consultar', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { pregunta, sessionId } = req.body;
    
    if (!pregunta) {
      return res.status(400).json({ error: 'Pregunta requerida' });
    }

    if (!openai) {
      return res.status(500).json({ error: 'OpenAI API Key no configurada en el servidor' });
    }

    // Cargar conversación existente
    let conversation = await loadConversation(sessionId);
    
    // Si no existe, crear nueva conversación
    if (!conversation) {
      conversation = {
        sessionId,
        messages: [],
        lastActivity: Date.now(),
        createdAt: Date.now(),
        totalInteractions: 0
      };
    }

    // Agregar mensaje del usuario
    conversation.messages.push({
      role: 'user',
      content: pregunta
    });

    // Crear el prompt del sistema
    const systemPrompt = `Eres Uli, un experto en Marketing y Desarrollo Tecnológico. 
Responde de manera natural y profesional, manteniendo el contexto de la conversación.
Tienes acceso al historial de la conversación para mantener coherencia.`;

    // Preparar mensajes para OpenAI
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversation.messages
    ];

    // Llamar a OpenAI
    const completion = await openai.completions.create({
      model: 'gpt-3.5-turbo-instruct',
      prompt: messages.map(m => `${m.role}: ${m.content}`).join('\n') + '\nassistant:',
      max_tokens: 500,
      temperature: 0.7
    });

    const respuesta = completion.choices[0].text.trim();

    // Agregar respuesta al historial
    conversation.messages.push({
      role: 'assistant',
      content: respuesta
    });

    // Actualizar metadatos
    conversation.lastActivity = Date.now();
    conversation.totalInteractions++;

    // Guardar conversación (rápido en memoria, diferido en Redis)
    await saveConversation(sessionId, conversation);

    console.log(`💬 [${sessionId}] P: ${pregunta.substring(0, 30)}... | R: ${respuesta.substring(0, 30)}...`);

    res.json({ respuesta });

  } catch (error) {
    console.error('Error en /api/consultar:', error);
    res.status(500).json({ error: 'Error interno del servidor: ' + error.message });
  }
});

// Endpoint para consultar conversaciones guardadas
app.get('/api/conversaciones', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const conversaciones = await getAllConversations();
    
    // Ordenar por última actividad (más reciente primero)
    conversaciones.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
    
    res.json({
      total: conversaciones.length,
      almacenamiento: redis ? 'Redis (permanente)' : 'Memoria temporal',
      conversaciones
    });
    
  } catch (error) {
    console.error('Error consultando conversaciones:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint para obtener una conversación específica
app.get('/api/conversaciones/:sessionId', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const { sessionId } = req.params;
    const conversation = await loadConversation(sessionId);
    
    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }
    
    res.json({
      sessionId,
      createdAt: new Date(conversation.createdAt).toLocaleString('es-ES'),
      lastActivity: new Date(conversation.lastActivity).toLocaleString('es-ES'),
      totalMessages: conversation.messages.length,
      totalInteractions: conversation.totalInteractions,
      almacenamiento: redis ? 'Redis (permanente)' : 'Memoria temporal',
      messages: conversation.messages
    });
    
  } catch (error) {
    console.error('Error obteniendo conversación:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor iniciado en http://localhost:${PORT}`);
  console.log('💬 Tu chat está listo para probar');
  console.log('📝 Memoria implementada: las conversaciones se recordarán durante la sesión');
});
