// Endpoint para ver una conversación específica por sessionId
export default async function handler(req, res) {
  // Configurar CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Solo se permite GET' });
    return;
  }

  try {
    console.log('🔍 Endpoint /api/conversacion llamado');
    
    // Obtener sessionId de los query parameters
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');

    console.log('📝 SessionId solicitado:', sessionId);

    if (!sessionId) {
      res.status(400).json({ 
        error: 'Falta sessionId',
        message: 'Usa: /api/conversacion?sessionId=tu_session_id'
      });
      return;
    }

    // Verificar si las variables de entorno están configuradas (Vercel usa KV_REST_API_*)
    const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    
    console.log('🔍 Variables de entorno:', {
      hasRedisUrl: !!redisUrl,
      hasRedisToken: !!redisToken
    });
    
    if (!redisUrl || !redisToken) {
      res.status(500).json({ 
        error: 'Redis no configurado',
        message: 'Las variables de entorno de Redis no están configuradas'
      });
      return;
    }

    // Upstash Redis - importar aquí para evitar problemas en Vercel
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({
      url: redisUrl,
      token: redisToken,
    });

    // Obtener la conversación específica
    const conversation = await redis.get(`conversation:${sessionId}`);
    
    if (!conversation) {
      res.status(404).json({ 
        error: 'Conversación no encontrada',
        sessionId 
      });
      return;
    }

    // Formatear la respuesta
    const formatted = {
      sessionId: conversation.sessionId,
      totalMensajes: conversation.messages?.length || 0,
      ultimaActividad: new Date(conversation.lastActivity).toLocaleString('es-ES'),
      creada: new Date(conversation.createdAt).toLocaleString('es-ES'),
      totalInteracciones: conversation.totalInteractions || 0,
      userAgent: conversation.userAgent || 'unknown',
      mensajes: conversation.messages?.map((msg, index) => ({
        numero: index + 1,
        role: msg.role === 'user' ? 'Usuario' : 'Uli',
        contenido: msg.content,
        timestamp: new Date(msg.timestamp).toLocaleString('es-ES')
      })) || []
    };

    res.status(200).json(formatted);

  } catch (error) {
    console.error('Error obteniendo conversación:', error);
    res.status(500).json({ 
      error: 'Error interno del servidor',
      message: error.message 
    });
  }
}
