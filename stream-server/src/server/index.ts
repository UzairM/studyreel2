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
      
      // Store the stream ID for this socket for data channel association
      mediasoupServer.setSocketStreamId(socket.id, id);
      console.log(`Socket ${socket.id} is now associated with stream ${id}`);
      
      // Automatically create a data producer for chat if this is a video producer
      if (kind === 'video') {
        try {
          console.log(`Automatically creating data producer for chat for stream ${id}`);
          
          const transport = mediasoupServer.getTransports().get(transportId);
          if (!transport) {
            throw new Error(`Transport ${transportId} not found`);
          }
          
          // Ensure the transport has SCTP enabled
          if (!transport.sctpState) {
            console.warn('SCTP not enabled on this transport for auto data producer');
          } else {
            // Create data producer with proper SCTP parameters
            const dataProducer = await transport.produceData({
              sctpStreamParameters: {
                streamId: 0, // Stream ID is required by mediasoup
                ordered: true
              },
              label: 'chat',
              protocol: 'json',
              appData: { socketId: socket.id }
            });
            
            console.log(`Data producer ${dataProducer.id} automatically created for socket ${socket.id}`);
            
            // Store the data producer with a special ID for chat
            const dataProducerId = `${id}-data`;
            // Register the data producer with a custom ID for easy lookup
            mediasoupServer.addDataProducer(dataProducerId, dataProducer);
            console.log(`Data producer registered with custom ID: ${dataProducerId} (original ID: ${dataProducer.id})`);
          }
        } catch (dataError) {
          // Don't fail the whole producer creation if data producer fails
          console.error('Failed to create automatic data producer for chat:', dataError);
        }
      }
      
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
      // Store the consumer transport ID in the mapping
      socketToTransportId.set(socket.id, transport.id);
      console.log(`Associated socket ${socket.id} with transport ${transport.id} for consuming`);
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
      
      // Store the data producer with a special ID for chat
      const streamId = mediasoupServer.getSocketStreamId(socket.id);
      if (streamId) {
        const dataProducerId = `${streamId}-data`;
        // Register the data producer with a custom ID for easy lookup
        mediasoupServer.addDataProducer(dataProducerId, dataProducer);
        console.log(`Data producer registered with custom ID: ${dataProducerId} (original ID: ${dataProducer.id})`);
        
        // Set up listeners for the data producer to handle incoming messages
        mediasoupServer.setupDataProducerListeners(dataProducer, streamId);
      } else {
        console.warn(`No stream ID found for socket ${socket.id}, using original data producer ID`);
        // Still register the data producer with its original ID
        mediasoupServer.addDataProducer(dataProducer.id, dataProducer);
      }
      
      callback({ id: dataProducer.id });
    } catch (error) {
      console.error('Error producing data:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to produce data';
      callback({ error: errorMessage });
    }
  });

  socket.on('consumeData', async (data, callback) => {
    try {
      console.log(`Socket ${socket.id} is trying to consume data from producer ${data.dataProducerId}`);
      
      // Get the transport ID for this socket
      const transportId = socketToTransportId.get(socket.id);
      if (!transportId) {
        throw new Error(`No transport found for socket ${socket.id}`);
      }
      
      const transport = mediasoupServer.getTransports().get(transportId);
      if (!transport) {
        throw new Error(`Transport ${transportId} not found`);
      }
      
      console.log(`Got transport ${transportId} for consuming data, SCTP state: ${transport.sctpState}`);
      
      // First try with the given data producer ID
      const dataProducer = mediasoupServer.getDataProducer(data.dataProducerId);
      
      // If not found, try to get the stream ID from the data producer ID format (streamId-data)
      if (!dataProducer && data.dataProducerId.endsWith('-data')) {
        const streamId = data.dataProducerId.slice(0, -5); // Remove '-data' suffix
        console.log(`Extracted stream ID ${streamId} from data producer ID ${data.dataProducerId}`);
        const actualProducers = mediasoupServer.getDataProducers();
        console.log(`All data producers: [${Array.from(actualProducers.keys()).join(', ')}]`);
      }
      
      // If still not found, throw an error
      if (!dataProducer) {
        const streamId = mediasoupServer.getSocketStreamId(socket.id);
        console.error(`Data producer ${data.dataProducerId} not found for stream ${streamId}`);
        
        // Fallback: if this is a chat message consumer, create a socket-based handler instead
        if (data.dataProducerId.endsWith('-data')) {
          console.log(`Setting up socket.io fallback for chat messages for producer ${data.dataProducerId}`);
          callback({ 
            id: null, 
            sctpStreamParameters: null,
            label: 'chat',
            protocol: 'json',
            fallback: true 
          });
          return;
        }
        
        throw new Error(`Data producer ${data.dataProducerId} not found`);
      }
      
      console.log(`Creating data consumer for producer ${dataProducer.id} with protocol ${dataProducer.protocol}`);
      
      // Create the data consumer
      const dataConsumer = await transport.consumeData({ dataProducerId: dataProducer.id });
      
      console.log(`Data consumer ${dataConsumer.id} created for data producer ${dataProducer.id}`);
      
      callback({
        id: dataConsumer.id,
        dataProducerId: dataProducer.id,
        sctpStreamParameters: dataConsumer.sctpStreamParameters,
        label: dataConsumer.label,
        protocol: dataConsumer.protocol
      });
    } catch (error) {
      console.error('Error consuming data:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to consume data';
      callback({ error: errorMessage });
    }
  });

  socket.on('chatMessage', (data) => {
    try {
      console.log(`Chat message received from ${socket.id} for stream ${data.streamId}:`, data.message);
      
      // Broadcast the message to all viewers via socket.io
      // This is more reliable than using the data producer
      io.emit('broadcastChatMessage', {
        streamId: data.streamId,
        message: data.message
      });
      
      // Also try to send via data producer if available
      try {
        // Get the data producer ID for this stream
        const dataProducerId = `${data.streamId}-data`;
        const dataProducer = mediasoupServer.getDataProducer(dataProducerId);
        
        if (dataProducer) {
          console.log(`Sending chat message via data producer ${dataProducerId}`);
          // Serialize the message to send via the data producer
          const serializedMessage = JSON.stringify(data.message);
          const encodedMessage = Buffer.from(serializedMessage);
          dataProducer.send(encodedMessage);
        } else {
          console.log(`Data producer ${dataProducerId} not found for stream ${data.streamId}, using socket.io only`);
        }
      } catch (dataError) {
        console.error('Error sending message via data producer:', dataError);
        // We already sent via socket.io, so no need for additional handling
      }
    } catch (error) {
      console.error('Error handling chat message:', error);
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