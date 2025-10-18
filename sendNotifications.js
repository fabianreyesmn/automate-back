// sendNotifications.js
require('dotenv').config();
const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Inicializar Firebase Admin (toma JSON desde env o path)
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else {
  console.error('Falta FIREBASE_SERVICE_ACCOUNT_PATH o FIREBASE_SERVICE_ACCOUNT_JSON.');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

(async function main(){
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const maxDate = new Date(startOfToday);
    maxDate.setDate(maxDate.getDate() + 30);

    // Traer documentos con expiry_date entre hoy y +30 días
    const { data: docs, error } = await supabase
      .from('documents')
      .select('id, document_type, expiry_date, vehicle_id')
      .gte('expiry_date', startOfToday.toISOString().split('T')[0])
      .lte('expiry_date', maxDate.toISOString().split('T')[0]);

    if (error) throw error;
    const targets = [30, 15, 7];
    for (const d of docs) {
      const expiry = new Date(d.expiry_date);
      const diffDays = Math.ceil((expiry.getTime() - startOfToday.getTime()) / (1000*60*60*24));
      if (!targets.includes(diffDays)) continue;

      // obtener vehicle -> firebase_uid
      const { data: vehicleData, error: vErr } = await supabase.from('vehicles').select('firebase_uid').eq('id', d.vehicle_id).single();
      if (vErr || !vehicleData) {
        console.warn('No vehicle for doc', d.id);
        continue;
      }
      const firebaseUid = vehicleData.firebase_uid;

      // obtener tokens del usuario
      const { data: tokensData, error: tErr } = await supabase.from('devices').select('token').eq('firebase_uid', firebaseUid);
      if (tErr) {
        console.warn('No devices for user', firebaseUid);
        continue;
      }
      const tokens = (tokensData || []).map(x => x.token).filter(Boolean);
      if (tokens.length === 0) continue;

      const message = {
        notification: { title: 'Recordatorio AutoMate', body: `Tu ${d.document_type} caduca en ${diffDays} días.` },
        tokens
      };

      const resp = await admin.messaging().sendMulticast(message);
      console.log(`Enviado ${resp.successCount}/${tokens.length} para doc ${d.id} (${d.document_type}) - ${diffDays}d`);
    }
  } catch (err) {
    console.error('Error sendNotifications:', err);
    process.exit(1);
  }
})();
