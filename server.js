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

// Construye la respuesta de confirmación (ACK) para un paquete de login
function buildLoginAck(serialNumber) {
  const protocolNumber = 0x01;
  const content = Buffer.concat([
    Buffer.from([protocolNumber]),
    serialNumber, // 2 bytes, mismo serial que mandó el dispositivo
  ]);

  const length = content.length + 2; // +2 por el CRC que viene después
  const crcInput = Buffer.concat([Buffer.from([length]), content]);
  const crc = calculateCRC(crcInput);

  const crcBuffer = Buffer.alloc(2);
  crcBuffer.writeUInt16BE(crc, 0);

  const packet = Buffer.concat([
    Buffer.from([0x78, 0x78]), // inicio
    Buffer.from([length]),
    content,
    crcBuffer,
    Buffer.from([0x0d, 0x0a]), // fin
  ]);

  return packet;
}

const server = net.createServer((socket) => {
  const clientInfo = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[CONEXIÓN] Nuevo dispositivo conectado: ${clientInfo}`);

  socket.on('data', (data) => {
    console.log(`[DATOS] De ${clientInfo}:`);
    console.log(`  Hex: ${data.toString('hex')}`);
    console.log(`  Longitud: ${data.length} bytes`);
    console.log(`  Timestamp: ${new Date().toISOString()}`);

    // Validar que sea un paquete GT06 válido (empieza con 7878 y termina con 0d0a)
    if (data.length < 5 || data[0] !== 0x78 || data[1] !== 0x78) {
      console.log(`  [AVISO] Paquete no reconocido como GT06, se ignora`);
      return;
    }

    const protocolNumber = data[2 + 1]; // posición del byte de protocolo (después de 7878 + length)

    if (protocolNumber === 0x01) {
      // Es un paquete de LOGIN
      const imeiBytes = data.slice(4, 12); // 8 bytes de IMEI en BCD
      const imei = imeiBytes.toString('hex').replace(/^0/, ''); // quita el 0 inicial de relleno
      console.log(`  [LOGIN] IMEI del dispositivo: ${imei}`);

      const serialNumber = data.slice(12, 14); // 2 bytes de número de serie

      const ackPacket = buildLoginAck(serialNumber);
      socket.write(ackPacket);
      console.log(`  [RESPUESTA] ACK de login enviado: ${ackPacket.toString('hex')}`);
    } else {
      console.log(`  [INFO] Paquete tipo protocolo 0x${protocolNumber.toString(16)} recibido (no es login, aún no procesado)`);
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
