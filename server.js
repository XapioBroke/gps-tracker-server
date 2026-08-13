const net = require('net');

const PORT = process.env.PORT || 5023;

const server = net.createServer((socket) => {
  const clientInfo = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[CONEXIÓN] Nuevo dispositivo conectado: ${clientInfo}`);

  socket.on('data', (data) => {
    console.log(`[DATOS] De ${clientInfo}:`);
    console.log(`  Hex: ${data.toString('hex')}`);
    console.log(`  Longitud: ${data.length} bytes`);
    console.log(`  Timestamp: ${new Date().toISOString()}`);
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