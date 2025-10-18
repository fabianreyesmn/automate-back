// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

const PORT = process.env.PORT || 8080;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en variables de entorno.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Inicializar Firebase Admin (soporta 2 modos: path o JSON en env)
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else {
  console.error('Falta FIREBASE_SERVICE_ACCOUNT_PATH o FIREBASE_SERVICE_ACCOUNT_JSON.');
  // no exit - permitimos correr con SKIP_AUTH=true para dev
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
} else {
  console.warn('Firebase admin no inicializado (usar SKIP_AUTH=true para dev).');
}

// Middleware para verificar Firebase ID token
async function verifyToken(req, res, next) {
  if (process.env.SKIP_AUTH === 'true') {
    // modo desarrollo: setea un uid de prueba
    req.user = { uid: process.env.DEV_UID || 'dev-uid', email: 'dev@example.com' };
    return next();
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  const idToken = auth.split(' ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = decoded; // tiene uid, email...
    next();
  } catch (err) {
    console.error('Token inválido', err);
    res.status(401).json({ error: 'Token inválido' });
  }
}

const upload = multer({ storage: multer.memoryStorage() });

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// registerUser - upsert user by firebase_uid
app.post('/api/registerUser', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const email = req.user.email || req.body.email;
  const displayName = req.user.name || req.body.displayName || null;
  try {
    const { data, error } = await supabase
      .from('users')
      .upsert({ firebase_uid: uid, email, display_name: displayName }, { onConflict: 'firebase_uid' })
      .select().single();
    if (error) throw error;
    res.json({ ok: true, user: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || e });
  }
});

// create vehicle
app.post('/api/vehicles', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { make, model, year, license_plate } = req.body;
  try {
    const { data, error } = await supabase
      .from('vehicles')
      .insert({ firebase_uid: uid, make, model, year, license_plate })
      .select().single();
    if (error) throw error;
    res.json({ ok: true, vehicle: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || e });
  }
});

// list documents for vehicle
app.get('/api/vehicles/:vehicleId/documents', verifyToken, async (req, res) => {
  const { vehicleId } = req.params;
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('vehicle_id', vehicleId)
      .order('expiry_date', { ascending: true });
    if (error) throw error;
    res.json({ ok: true, documents: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || e });
  }
});

// upload document (multipart form-data: file, documentType, expiryDate)
app.post('/api/vehicles/:vehicleId/documents', verifyToken, upload.single('file'), async (req, res) => {
  const uid = req.user.uid;
  const { vehicleId } = req.params;
  const { documentType, expiryDate } = req.body;
  if (!req.file) return res.status(400).json({ error: 'file required' });

  const filename = `${Date.now()}_${req.file.originalname}`;
  const path = `${uid}/${vehicleId}/${filename}`;

  try {
    // subir a Supabase Storage
    const up = await supabase.storage.from('vehicle-docs').upload(path, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false
    });
    if (up.error) throw up.error;

    // obtener publicUrl (si bucket es público)
    const { data: urlData, error: urlErr } = await supabase.storage.from('vehicle-docs').getPublicUrl(path);
    if (urlErr) console.warn('No se obtuvo publicUrl', urlErr);

    const publicUrl = urlData?.publicUrl || null;

    // insertar registro en documents
    const { data, error } = await supabase
      .from('documents')
      .insert({
        vehicle_id: vehicleId,
        document_type: documentType,
        expiry_date: expiryDate,
        storage_path: publicUrl
      })
      .select().single();
    if (error) throw error;

    res.json({ ok: true, document: data });
  } catch (e) {
    console.error('Upload error', e);
    res.status(500).json({ error: e.message || e });
  }
});

// register device token
app.post('/api/registerDevice', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { token, platform } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const { data, error } = await supabase
      .from('devices')
      .upsert({ firebase_uid: uid, token, platform }, { onConflict: 'token' })
      .select().single();
    if (error) throw error;
    res.json({ ok: true, device: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || e });
  }
});

app.listen(PORT, () => {
  console.log(`Automate backend listening on port ${PORT}`);
});
