# API Server - Genesys Dashboard

Esta carpeta contiene la API Node.js (Express) que maneja la autenticación y la generación de tokens para la integración con Genesys Cloud, utilizando Firebase Firestore como base de datos.

## Estructura de la Base de Datos (Firestore)

El sistema utiliza tres colecciones principales en Firestore para segmentar por roles y manejar las credenciales:

1. **`organizations`** (Anteriormente `usersGenesysMetrics` en DynamoDB):
   - ID del documento: `orgId`
   - Contiene la información de cada organización (hija), incluyendo el `thrusted` al que pertenece, `orgname`, `region` y `criticalMetrics`.

2. **`users`**:
   - ID del documento: `username` (email)
   - Contiene la información de los usuarios y su Rol Basado en Acceso (RBAC):
     - `role`: Puede ser `client`, `supervisor` o `administrator`.
     - `thrusted`: El grupo regional al que pertenece (importante para el supervisor).
     - `orgname`: La organización hija a la que pertenece (importante para el client).
     - `passwordHash`: Contraseña encriptada con bcrypt.

3. **`credentials`**:
   - ID del documento: Generado por Firestore o el nombre del thrusted.
   - Contiene las credenciales máster de Genesys Cloud por cada Thrusted (ej. `ESMT-DEV`, `ESMT-DEV-W2`).
   - Campos: `name` (thrusted), `clientId`, `clientSecret`, `orgId`, `region`.

## Endpoints

### 1. Generar Token de Genesys Cloud
`POST /api/token`

Genera un token de acceso directamente usando el SDK de PureCloud. No requiere estar autenticado (uso interno/servicio a servicio).

**Body:**
```json
{
  "clientId": "tu_client_id",
  "clientSecret": "tu_client_secret",
  "region": "us-east-1"
}
```

**Respuesta:**
```json
{
  "success": true,
  "token": "ey..."
}
```

### 2. Login de Usuario
`POST /api/login`

Valida las credenciales de un usuario contra Firestore y, dependiendo de su rol, retorna los tokens de Genesys Cloud correspondientes.

**Body:**
```json
{
  "orgname": "endocrino-ace",
  "username": "soporte",
  "password": "mi_password"
}
```

**Lógica de Roles (RBAC):**
- **Administrador (`administrator`)**: Retorna un objeto con tokens de **todas** las regiones/thrusted disponibles en la colección `credentials`.
- **Supervisor (`supervisor`)**: Retorna un string con el token exclusivo del `thrusted` al que está asignado el supervisor.
- **Cliente (`client`)**: Retorna un string con el token exclusivo del `thrusted` correspondiente a su `orgname`.

**Respuesta (Ejemplo Cliente/Supervisor):**
```json
{
  "success": true,
  "message": "Login exitoso",
  "user": { ... },
  "token": "ey..."
}
```

**Respuesta (Ejemplo Administrador):**
```json
{
  "success": true,
  "message": "Login exitoso",
  "user": { ... },
  "token": {
    "ESMT-DEV": "ey...",
    "ESMT-DEV-W2": "ey..."
}
```

### 3. Obtener Resumen de Facturación (Trustee Billing Overview)
`POST /api/trusteebillingoverview`

Permite obtener el resumen de facturación de una organización de la cual somos "trustee" (es decir, tenemos permisos delegados), usando el SDK de PureCloud (`BillingApi`).

**Body:**
```json
{
  "trustorOrgId": "id_de_la_organizacion_cliente",
  "accessToken": "ey...",
  "billingPeriodIndex": 0,
  "region": "us-east-1"
}
```
- `trustorOrgId`: El ID de la organización de la cual queremos ver la facturación.
- `accessToken`: El token generado en el endpoint `/api/token` o en el login.
- `billingPeriodIndex`: Índice del periodo de facturación (0 para el actual).
- `region`: (Opcional) Región donde opera la organización. Por defecto `us-east-1`.

**Respuesta:**
```json
{
  "success": true,
  "data": {
    "billingPeriod": { ... },
    "currency": "USD",
    ...
  }
}
```

### 4. Obtener Uso Facturable (Billable Usage)
`POST /api/billableusage`

Permite obtener el reporte de uso facturable (`getBillingReportsBillableusage`) de la organización principal para un periodo específico, usando el SDK de PureCloud (`BillingApi`).

**Body:**
```json
{
  "accessToken": "ey...",
  "startDate": "2023-10-01T00:00:00Z",
  "endDate": "2023-10-31T23:59:59Z",
  "region": "us-east-1"
}
```
- `accessToken`: El token generado en el endpoint `/api/token` o en el login.
- `startDate`: Fecha de inicio del reporte en formato ISO.
- `endDate`: Fecha de fin del reporte en formato ISO.
- `region`: (Opcional) Región donde opera la organización. Por defecto `us-east-1`.

**Respuesta:**
```json
{
  "success": true,
  "data": {
    "usages": [ ... ],
    ...
  }
}
```

### 5. Obtener Datos de Divisiones y Usuarios (Divisions Data)
`POST /api/divisionsdata`

Obtiene la lista de todas las divisiones configuradas en la organización y mapea todos los usuarios que pertenecen a cada división. Esto se hace consultando directamente los endpoints de Genesys Cloud `api/v2/authorization/divisions` y `api/v2/search`.

**Body:**
```json
{
  "accessToken": "ey...",
  "region": "us-east-1"
}
```
- `accessToken`: El token de acceso a Genesys Cloud.
- `region`: Región de la organización (ej. `us-east-1`, `us-west-2`).

**Respuesta:**
*(Retorna un Array directamente, a diferencia de los otros endpoints)*
```json
[
  {
    "id": "1234-abcd-...",
    "name": "Division Principal",
    "description": "...",
    "users": [
      {
        "divisionId": "1234-abcd-...",
        "email": "usuario@empresa.com",
      }
    ]
  }
]
```

### 6. Gestionar Usuarios (Set User)
`GET /api/setuser`
`POST /api/setuser`

Este endpoint permite listar, crear y actualizar usuarios y organizaciones en Firestore, unificando la lógica que previamente existía en DynamoDB.

**GET:**
- Sin parámetros: Devuelve un arreglo de todas las organizaciones, con sus usuarios anidados dentro de un arreglo `users` (compatible con la vista de settings).
- Con `?username=...&orgname=...`: Devuelve los detalles de un usuario específico.

**POST Body:**
```json
{
  "orgname": "endocrino-ace",
  "orgId": "1234-abcd",
  "mode": "update",
  "user": {
    "user": {
      "username": "usuario@empresa.com",
      "role": "client",
      "preferences": {}
    },
    "password": "nueva_password" 
  }
}
```
- El modo `update` permite actualizar a un usuario existente.
- En la creación (sin modo update), la contraseña es obligatoria.
- La información de la organización (orgname, orgId) se actualiza dinámicamente si no existía.

### 7. Enviar Correos (Send Mail)
`POST /api/sendmail`

Envía correos electrónicos utilizando el servicio **Resend**. Requiere que la variable de entorno `RESEND_API_KEY` esté configurada en el servidor.

**Body:**
```json
{
  "to": ["destinatario@correo.com"],
  "subject": "Asunto del correo",
  "message": "<h1>Contenido HTML</h1>"
}
```
- `to`: Arreglo de strings con los correos de los destinatarios.
- `subject`: Asunto del mensaje.
- `message`: Contenido del mensaje en formato HTML.

**Respuesta:**
```json
{
  "success": true,
  "message": "Correos enviados con éxito",
  "id": "transaccion_id"
}
```
