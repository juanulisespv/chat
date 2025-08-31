# ✅ Configuración Upstash Redis para Vercel

## 🚀 Pasos de Configuración:

### 1. Crear Base de Datos en Vercel
1. Ve a [Vercel Dashboard](https://vercel.com/dashboard)
2. Selecciona tu proyecto "chat"
3. Ve a "Storage" → "Upstash" → "Add Integration"
4. Crea cuenta en Upstash (gratis)
5. Crea base de datos Redis
6. Conecta la integración con Vercel

### 2. Variables de Entorno (Automáticas)
Vercel configurará automáticamente:
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

### 3. Deploy
```bash
vercel --prod
```

## 🎯 Una vez configurado podrás:

### Ver todas las conversaciones:
```
https://tu-app.vercel.app/api/conversaciones?action=list
```

### Ver conversación específica:
```
https://tu-app.vercel.app/api/conversaciones?sessionId=session_123
```

### Información de la API:
```
https://tu-app.vercel.app/api/conversaciones
```

## 💾 Almacenamiento:
- **Permanente**: Las conversaciones nunca se borran
- **Rápido**: Redis es ultrarrápido
- **Gratis**: 10,000 comandos/día gratis en Upstash
- **Escalable**: Puede crecer según necesites

## 🔍 Logs disponibles en Vercel Functions para debug
