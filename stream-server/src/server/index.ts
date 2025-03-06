import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { MediasoupServer } from './mediasoup';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const mediasoupServer = new MediasoupServer();
// Map to track socket to transport IDs
const socketToTransportId = new Map<string, string>();

app.use(cors());
app.use(express.json());

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('getRouterRtpCapabilities', async (callback) => {
    try {
      const capabilities = mediasoupServer.getRtpCapabilities();
      console.log('Sending RTP capabilities to client:', socket.id);
      callback(capabilities);
    } catch (error) {
      console.error('Error getting RTP capabilities:', error);
      callback({ error: 'Failed to get RTP capabilities' });
    }
  });

  socket.on('createProducerTransport', async (_data, callback) => {
    try {
      // Create the transport with SCTP enabled
      const transport = await mediasoupServer.createWebRtcTransport(socket.id);
      // Store the transport ID for this socket
      socketToTransportId.set(socket.id, transport.id);
      console.log(`Socket ${socket.id} associated with transport ${transport.id}`);
      console.log('Returning transport with SCTP parameters:', transport.sctpParameters);
      callback(transport);
    } catch (error) {
      console.error('Error creating WebRTC transport:', error);
      callback({ error: 'Failed to create transport' });
    }
  });

  socket.on('connectProducerTransport', async ({ dtlsParameters }, callback) => {
    try {
      console.log(`Attempting to connect transport for socket ${socket.id}`);
      // Get the transport ID for this socket
      const transportId = socketToTransportId.get(socket.id);
      if (!transportId) {
        throw new Error(`No transport found for socket ${socket.id}`);
      }
      console.log(`Found transport ${transportId} for socket ${socket.id}`);
      
      await mediasoupServer.connectTransport(socket.id, dtlsParameters);
      console.log(`Transport ${transportId} connected for socket ${socket.id}`);
      callback({ success: true });
    } catch (error) {
      console.error('Error connecting transport:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect transport';
      callback({ error: errorMessage });
    }
  });

  socket.on('produce', async ({ kind, rtpParameters }, callback) => {
    try {
      console.log(`Socket ${socket.id} is trying to produce ${kind}`);
      // Get the transport ID for this socket
      const transportId = socketToTransportId.get(socket.id);
      if (!transportId) {
        throw new Error(`No transport found for socket ${socket.id}`);
      }
      console.log(`Using transport ${transportId} for producing`);
      
      const { id } = await mediasoupServer.produce(socket.id, kind, rtpParameters);
      console.log(`Producer ${id} created successfully with kind ${kind}`);
      
      // Notify all clients about the new producer
      socket.broadcast.emit('newProducer', {
        producerId: id,
        kind
      });
      
      callback({ id });
    } catch (error) {
      console.error('Error producing:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to produce';
      callback({ error: errorMessage });
    }
  });

  socket.on('createConsumerTransport', async (callback) => {
    try {
      const transport = await mediasoupServer.createWebRtcTransport(socket.id);
      console.log(`Consumer transport created for socket ${socket.id}: ${transport.id}`);
      callback(transport);
    } catch (error) {
      console.error('Error creating consumer transport:', error);
      callback({ error: 'Failed to create consumer transport' });
    }
  });

  socket.on('connectConsumerTransport', async ({ transportId, dtlsParameters }, callback) => {
    try {
      console.log(`Connecting consumer transport ${transportId} for socket ${socket.id}`);
      const transport = mediasoupServer.getTransports().get(transportId);
      if (!transport) throw new Error(`Transport ${transportId} not found`);
      
      await transport.connect({ dtlsParameters });
      console.log(`Consumer transport ${transportId} connected successfully`);
      callback({ success: true });
    } catch (error) {
      console.error('Error connecting consumer transport:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect consumer transport';
      callback({ error: errorMessage });
    }
  });

  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
    try {
      console.log(`Socket ${socket.id} wants to consume producer ${producerId} with transport ${transportId}`);
      const result = await mediasoupServer.consume(transportId, producerId, rtpCapabilities);
      console.log(`Consumer created for producer ${producerId}`);
      callback(result);
    } catch (error) {
      console.error('Error consuming:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to consume';
      callback({ error: errorMessage });
    }
  });

  socket.on('getProducers', (callback) => {
    try {
      const producers = mediasoupServer.getProducers();
      console.log(`Getting ${producers.length} producers`);
      callback(producers);
    } catch (error) {
      console.error('Error getting producers:', error);
      callback({ error: 'Failed to get producers' });
    }
  });

  socket.on('produceData', async (data, callback) => {
    try {
      console.log(`Socket ${socket.id} is trying to produce data channel`);
      // Get the transport ID for this socket
      const transportId = socketToTransportId.get(socket.id);
      if (!transportId) {
        throw new Error(`No transport found for socket ${socket.id}`);
      }
      console.log(`Using transport ${transportId} for data producing`);
      
      const transport = mediasoupServer.getTransports().get(transportId);
      if (!transport) {
        throw new Error(`Transport ${transportId} not found`);
      }
      
      // Ensure the transport has SCTP enabled
      if (!transport.sctpState) {
        throw new Error('SCTP not enabled on this transport');
      }
      
      // Create data producer
      const dataProducer = await transport.produceData(data);
      console.log(`Data producer ${dataProducer.id} created for socket ${socket.id}`);
      
      callback({ id: dataProducer.id });
    } catch (error) {
      console.error('Error producing data:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to produce data';
      callback({ error: errorMessage });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    // Clean up the transport mapping
    socketToTransportId.delete(socket.id);
    mediasoupServer.cleanup(socket.id);
  });
});

// Initialize mediasoup and start server
const PORT = process.env.PORT || 3001;

async function start() {
  try {
    await mediasoupServer.init();
    httpServer.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start(); 