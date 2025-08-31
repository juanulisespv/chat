const { Redis } = require('@upstash/redis');

module.exports = async (req, res) => {
  // Solo permitir GET para consultas
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  try {
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    const { sessionId, action } = req.query;

    if (action === 'list') {
      // Listar todas las sesiones de conversación
      const sessions = await redis.smembers('conversation_sessions');
      
      const conversationsInfo = [];
      for (const session of sessions.slice(0, 20)) { // Limitar a 20 más recientes
        const conversation = await redis.get(`conversation:${session}`);
        if (conversation) {
          conversationsInfo.push({
            sessionId: session,
            totalMessages: conversation.messages.length,
            createdAt: new Date(conversation.createdAt).toISOString(),
            lastActivity: new Date(conversation.lastActivity).toISOString(),
            totalInteractions: conversation.totalInteractions,
            firstMessage: conversation.messages.find(m => m.role === 'user')?.content?.substring(0, 80) || 'Sin mensajes'
          });
        }
      }
      
      // Ordenar por última actividad
      conversationsInfo.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
      
      res.status(200).json({ conversaciones: conversationsInfo });
      return;
    }

    if (sessionId) {
      // Obtener conversación específica
      const conversation = await redis.get(`conversation:${sessionId}`);
      
      if (conversation) {
        res.status(200).json({
          sessionId,
          found: true,
          conversation: {
            totalMessages: conversation.messages.length,
            createdAt: new Date(conversation.createdAt).toISOString(),
            lastActivity: new Date(conversation.lastActivity).toISOString(),
            totalInteractions: conversation.totalInteractions,
            messages: conversation.messages.map(m => ({
              role: m.role,
              content: m.content,
              timestamp: new Date(m.timestamp).toISOString()
            }))
          }
        });
      } else {
        res.status(404).json({ 
          sessionId,
          found: false,
          message: 'Conversación no encontrada'
        });
      }
    } else {
      res.status(200).json({ 
        message: 'API de conversaciones activa',
        usage: {
          'Listar conversaciones': '/api/conversaciones?action=list',
          'Ver conversación': '/api/conversaciones?sessionId=session_123'
        }
      });
    }

  } catch (error) {
    console.error('Error consultando conversaciones:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};