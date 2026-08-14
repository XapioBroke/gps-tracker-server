const net = require('net');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const PORT = process.env.PORT || 5023;

// ---- Inicialización de Firebase ----
// En Railway: lee la credencial desde la variable de entorno FIREBASE_KEY (texto JSON completo)
// En local: si no existe esa variable, usa el archivo firebase-key.json
let serviceAccount;
if (process.env.FIREBASE_KEY) {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} else {
  serviceAccount = require('./firebase-key.json');
}

initializeApp({
  credential: cert(serviceAccount),
});
const db = getFirestore();

// Calcula el CRC-16/X25 que usa el protocolo GT06 para verificar integridad
function calculateCRC(buffer) {
  let crc = 0xFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x0001) {
        crc = (crc >> 1) ^ 0x8408;
      } else {
        crc = crc >> 1;
      }
    }
  }
  crc = ~crc & 0xFFFF;
  return crc;
}

// Construye una respuesta ACK genérica (sirve para login 0x01, status 0x13, posición 0x12/0x22)
function buildAck(protocolNumber, serialNumber) {
  const content = Buffer.concat([
    Buffer.from([protocolNumber]),
    serialNumber,
  ]);

  const length = content.length + 2;
  const crcInput = Buffer.concat([Buffer.from([length]), content]);
  const crc = calculateCRC(crcInput);

  const crcBuffer = Buffer.alloc(2);
  crcBuffer.writeUInt16BE(crc, 0);

  return Buffer.concat([
    Buffer.from([0x78, 0x78]),
    Buffer.from([length]),
    content,
    crcBuffer,
    Buffer.from([0x0d, 0x0a]),
  ]);
}

// Guarda una posición GPS en Firestore
async function savePosition(imei, positionData) {
  try {
    await db.collection('devices').doc(imei).set({
      lastPosition: positionData,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    await db.collection('devices').doc(imei).collection('history').add({
      ...positionData,
      createdAt: FieldValue.serverTimestamp(),
    });

    console.log(`  [FIREBASE] Posición guardada para IMEI ${imei}`);
  } catch (err) {
    console.log(`  [ERROR FIREBASE] No se pudo guardar: ${err.message}`);
  }
}

// Procesa UN solo paquete GT06 completo ya separado
function processPacket(data, socket, clientInfo, connectionState) {
  console.log(`[PAQUETE] De ${clientInfo}:`);
  console.log(`  Hex: ${data.toString('hex')}`);
  console.log(`  Longitud: ${data.length} bytes`);

  if (data.length < 5 || data[0] !== 0x78 || data[1] !== 0x78) {
    console.log(`  [AVISO] Paquete no reconocido como GT06, se ignora`);
    return;
  }

  const protocolNumber = data[3];

  if (protocolNumber === 0x01) {
    const imeiBytes = data.slice(4, 12);
    const imei = imeiBytes.toString('hex').replace(/^0/, '');
    connectionState.imei = imei;
    console.log(`  [LOGIN] IMEI del dispositivo: ${imei}`);

    const serialNumber = data.slice(12, 14);
    const ackPacket = buildAck(0x01, serialNumber);
    socket.write(ackPacket);
    console.log(`  [RESPUESTA] ACK de login enviado: ${ackPacket.toString('hex')}`);

  } else if (protocolNumber === 0x13) {
    const serialNumber = data.slice(data.length - 6, data.length - 4);
    const ackPacket = buildAck(0x13, serialNumber);
    socket.write(ackPacket);
    console.log(`  [HEARTBEAT] Paquete de estado recibido`);
    console.log(`  [RESPUESTA] ACK de status enviado: ${ackPacket.toString('hex')}`);

  } else if (protocolNumber === 0x12 || protocolNumber === 0x22) {
    console.log(`  [GPS] ¡Paquete de posición recibido! (protocolo 0x${protocolNumber.toString(16)})`);

    try {
      const year = 2000 + data[4];
      const month = data[5];
      const day = data[6];
      const hour = data[7];
      const minute = data[8];
      const second = data[9];

      const latRaw = data.readUInt32BE(11);
      const lonRaw = data.readUInt32BE(15);

      const latitude = latRaw / 1800000;
      const longitude = lonRaw / 1800000;

      const courseStatus = data.readUInt16BE(20);
      const isSouth = !((courseStatus >> 10) & 0x01);
      const isWest = ((courseStatus >> 11) & 0x01) === 1;

      const finalLat = isSouth ? -latitude : latitude;
      const finalLon = isWest ? -longitude : longitude;

      console.log(`  [GPS] Posición decodificada:`);
      console.log(`    Fecha/hora: ${year}-${month}-${day} ${hour}:${minute}:${second} UTC`);
      console.log(`    Latitud: ${finalLat.toFixed(6)}`);
      console.log(`    Longitud: ${finalLon.toFixed(6)}`);
      console.log(`    Google Maps: https://maps.google.com/?q=${finalLat.toFixed(6)},${finalLon.toFixed(6)}`);

      if (connectionState.imei) {
        savePosition(connectionState.imei, {
          latitude: finalLat,
          longitude: finalLon,
          timestampUTC: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`,
        });
      } else {
        console.log(`  [AVISO] Posición recibida sin login previo, no se guarda (falta IMEI)`);
      }
    } catch (err) {
      console.log(`  [ERROR GPS] No se pudo decodificar la posición: ${err.message}`);
    }

    const serialNumber = data.slice(data.length - 6, data.length - 4);
    const ackPacket = buildAck(protocolNumber, serialNumber);
    socket.write(ackPacket);
    console.log(`  [RESPUESTA] ACK de posición enviado: ${ackPacket.toString('hex')}`);

  } else {
    console.log(`  [INFO] Paquete tipo protocolo 0x${protocolNumber.toString(16)} recibido (aún no procesado)`);
  }
}

const server = net.createServer((socket) => {
  const clientInfo = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[CONEXIÓN] Nuevo dispositivo conectado: ${clientInfo}`);

  let buffer = Buffer.alloc(0);
  const connectionState = { imei: null };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const startIndex = buffer.indexOf(Buffer.from([0x78, 0x78]));
      if (startIndex === -1) {
        buffer = Buffer.alloc(0);
        break;
      }
      if (startIndex > 0) {
        buffer = buffer.slice(startIndex);
      }

      const endIndex = buffer.indexOf(Buffer.from([0x0d, 0x0a]));
      if (endIndex === -1) {
        break;
      }

      const packet = buffer.slice(0, endIndex + 2);
      buffer = buffer.slice(endIndex + 2);

      processPacket(packet, socket, clientInfo, connectionState);
    }
  });

  socket.on('close', () => {
    console.log(`[DESCONEXIÓN] ${clientInfo} se desconectó`);
  });

  socket.on('error', (err) => {
    console.log(`[ERROR] ${clientInfo}: ${err.message}`);
  });
});

server.on('error', (err) => {
  console.log(`[ERROR SERVIDOR] ${err.message}`);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor TCP escuchando en puerto ${PORT}`);
  console.log(`Esperando conexiones de dispositivos GPS...`);
});