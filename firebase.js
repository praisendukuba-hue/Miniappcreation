const admin = require('firebase-admin');
const path = require('path');
const serviceAccountPath = process.env.FIREBASE_CREDENTIALS_PATH || './serviceAccountKey.json';
const serviceAccount = require(path.resolve(serviceAccountPath));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.RTDB_URL || ''
});
const db = admin.firestore();
let rtdb = null;
if (process.env.RTDB_URL) rtdb = admin.database();
module.exports = { admin, db, rtdb };
