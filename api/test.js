// Endpoint simple para probar que funciona en Vercel
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Solo se permite GET' });
  }

  try {
    console.log('🧪 Test endpoint llamado');
    
    res.status(200).json({
      status: 'OK',
      message: 'Endpoint funcionando correctamente',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'unknown',
      hasOpenAI: !!process.env.OPENAI_API_KEY,
      hasRedisUrl: !!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL),
      hasRedisToken: !!(process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)
    });
    
  } catch (error) {
    console.error('Error en test:', error);
    res.status(500).json({ 
      error: 'Error interno',
      message: error.message
    });
  }
};
