const net = require('net');

const PORT = process.env.PORT || 5023;

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

const server = net.createServer((socket) => {
  const clientInfo = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[CONEXIÓN] Nuevo dispositivo conectado: ${clientInfo}`);

  socket.on('data', (data) => {
    console.log(`[DATOS] De ${clientInfo}:`);
    console.log(`  Hex: ${data.toString('hex')}`);
    console.log(`  Longitud: ${data.length} bytes`);

    if (data.length < 5 || data[0] !== 0x78 || data[1] !== 0x78) {
      console.log(`  [AVISO] Paquete no reconocido como GT06, se ignora`);
      return;
    }

    const protocolNumber = data[3];

    if (protocolNumber === 0x01) {
      // LOGIN
      const imeiBytes = data.slice(4, 12);
      const imei = imeiBytes.toString('hex').replace(/^0/, '');
      console.log(`  [LOGIN] IMEI del dispositivo: ${imei}`);

      const serialNumber = data.slice(12, 14);
      const ackPacket = buildAck(0x01, serialNumber);
      socket.write(ackPacket);
      console.log(`  [RESPUESTA] ACK de login enviado: ${ackPacket.toString('hex')}`);

    } else if (protocolNumber === 0x13) {
      // STATUS / HEARTBEAT
      const serialNumber = data.slice(data.length - 6, data.length - 4);
      const ackPacket = buildAck(0x13, serialNumber);
      socket.write(ackPacket);
      console.log(`  [HEARTBEAT] Paquete de estado recibido`);
      console.log(`  [RESPUESTA] ACK de status enviado: ${ackPacket.toString('hex')}`);

    } else if (protocolNumber === 0x12 || protocolNumber === 0x22) {
      // POSICIÓN GPS
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
        const isWest = !((courseStatus >> 11) & 0x01);

        const finalLat = isSouth ? -latitude : latitude;
        const finalLon = isWest ? -longitude : longitude;

        console.log(`  [GPS] Posición decodificada:`);
        console.log(`    Fecha/hora: ${year}-${month}-${day} ${hour}:${minute}:${second} UTC`);
        console.log(`    Latitud: ${finalLat.toFixed(6)}`);
        console.log(`    Longitud: ${finalLon.toFixed(6)}`);
        console.log(`    Google Maps: https://maps.google.com/?q=${finalLat.toFixed(6)},${finalLon.toFixed(6)}`);
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