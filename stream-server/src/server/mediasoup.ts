import * as mediasoup from 'mediasoup';
import { Worker, Router, WebRtcTransport, Producer, DataProducer, RtpCodecCapability, DtlsParameters, RtpParameters } from 'mediasoup/node/lib/types';

export class MediasoupServer {
  private worker: Worker | null = null;
  private router: Router | null = null;
  private producers: Map<string, Producer> = new Map();
  private dataProducers: Map<string, DataProducer> = new Map();
  private transports: Map<string, WebRtcTransport> = new Map();
  private socketToTransport: Map<string, string> = new Map(); // Map socketId to transportId
  private socketToStreamId: Map<string, string> = new Map(); // Map socketId to streamId

  async init() {
    console.log('Initializing Mediasoup worker...');
    this.worker = await mediasoup.createWorker({
      logLevel: 'debug', // Set to debug for more verbose output
      rtcMinPort: 10000,
      rtcMaxPort: 10100,
    });

    this.worker.on('died', () => {
      console.error('Mediasoup worker died unexpectedly! This is a critical error.');
      setTimeout(() => process.exit(1), 2000);
    });

    const mediaCodecs: RtpCodecCapability[] = [
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
          'x-google-start-bitrate': 1000,
        },
      },
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
      },
    ];

    console.log('Creating Mediasoup router with codecs:', mediaCodecs);
    this.router = await this.worker.createRouter({ mediaCodecs });
    console.log('Mediasoup worker and router initialized with capabilities:', this.router.rtpCapabilities);
  }

  getRtpCapabilities() {
    if (!this.router) {
      throw new Error('Router not initialized');
    }
    return this.router.rtpCapabilities;
  }

  getTransports() {
    return this.transports;
  }

  async createWebRtcTransport(socketId: string) {
    console.log(`Creating WebRTC transport for socket ${socketId}`);
    
    if (!this.router) {
      throw new Error('Router not initialized');
    }
    
    try {
      const transport = await this.router.createWebRtcTransport({
        listenIps: [
          {
            ip: '0.0.0.0',
            announcedIp: '127.0.0.1', // Change this to your public IP in production
          },
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        // Enable SCTP for data channels
        enableSctp: true,
        numSctpStreams: { OS: 1024, MIS: 1024 },
        appData: { socketId }
      });

      // Log ICE and DTLS parameters for debugging
      console.log(`Transport ${transport.id} parameters:`, {
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates.length,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters // Log SCTP parameters
      });

      // Handle transport events
      transport.on('icestatechange', (iceState) => {
        console.log(`Transport ${transport.id} ICE state changed to ${iceState}`);
      });

      transport.on('dtlsstatechange', (dtlsState) => {
        console.log(`Transport ${transport.id} DTLS state changed to ${dtlsState}`);
        if (dtlsState === 'failed' || dtlsState === 'closed') {
          console.error(`Transport ${transport.id} DTLS failed or closed`);
        }
      });

      transport.on('sctpstatechange', (sctpState) => {
        console.log(`Transport ${transport.id} SCTP state changed to ${sctpState}`);
        if (sctpState === 'failed') {
          console.error(`Transport ${transport.id} SCTP failed`);
        }
      });

      // Use observer instead of direct event for close
      transport.observer.on('close', () => {
        console.log(`Transport ${transport.id} closed`);
      });

      this.transports.set(transport.id, transport);
      this.socketToTransport.set(socketId, transport.id);
      
      console.log(`Created transport ${transport.id} for socket ${socketId}`);

      return {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters, // Important: Include SCTP parameters
      };
    } catch (error) {
      console.error(`Error creating WebRTC transport for socket ${socketId}:`, error);
      throw error;
    }
  }

  async connectTransport(socketId: string, dtlsParameters: DtlsParameters) {
    console.log(`Connecting transport for socket ${socketId}`);
    const transportId = this.socketToTransport.get(socketId);
    
    if (!transportId) {
      console.error(`No transport found for socket ${socketId}`);
      throw new Error(`No transport found for socket ${socketId}`);
    }
    
    const transport = this.transports.get(transportId);
    if (!transport) {
      console.error(`Transport ${transportId} not found`);
      throw new Error(`Transport ${transportId} not found`);
    }
    
    try {
      await transport.connect({ dtlsParameters });
      console.log(`Transport ${transportId} connected for socket ${socketId}`);
    } catch (error) {
      console.error(`Error connecting transport ${transportId}:`, error);
      throw error;
    }
  }

  async produce(socketId: string, kind: mediasoup.types.MediaKind, rtpParameters: RtpParameters) {
    console.log(`Producing ${kind} stream for socket ${socketId}, RTP parameters:`, JSON.stringify(rtpParameters, null, 2));
    const transportId = this.socketToTransport.get(socketId);
    
    if (!transportId) {
      console.error(`No transport found for socket ${socketId}`);
      throw new Error(`No transport found for socket ${socketId}`);
    }
    
    const transport = this.transports.get(transportId);
    if (!transport) {
      console.error(`Transport ${transportId} not found`);
      throw new Error(`Transport ${transportId} not found`);
    }

    try {
      const producer = await transport.produce({ kind, rtpParameters });
      this.producers.set(producer.id, producer);
      
      // Store the mapping of socket to stream ID
      this.socketToStreamId.set(socketId, producer.id);
      console.log(`Socket ${socketId} is now associated with stream ${producer.id}`);

      console.log(`Producer ${producer.id} created for socket ${socketId} with kind ${kind}`);

      producer.on('transportclose', () => {
        console.log(`Producer ${producer.id} closed due to transport close`);
        this.producers.delete(producer.id);
      });

      producer.observer.on('close', () => {
        console.log(`Producer ${producer.id} closed`);
        this.producers.delete(producer.id);
      });

      // Log current producers after adding a new one
      console.log(`Current producers (${this.producers.size}):`, 
        Array.from(this.producers.entries()).map(([id, p]) => ({ id, kind: p.kind })));

      return { id: producer.id };
    } catch (error) {
      console.error(`Error creating producer for socket ${socketId}:`, error);
      throw error;
    }
  }

  getProducers() {
    const producerList = Array.from(this.producers.values()).map(producer => ({
      id: producer.id,
      kind: producer.kind,
    }));
    console.log(`Getting ${producerList.length} producers`);
    return producerList;
  }

  // Add a producer with a custom ID
  addProducer(id: string, producer: Producer) {
    console.log(`Adding producer with custom ID: ${id}`);
    this.producers.set(id, producer);
  }

  // Get a specific producer by ID
  getProducer(id: string) {
    return this.producers.get(id);
  }

  // Add a data producer with a custom ID
  addDataProducer(id: string, dataProducer: DataProducer) {
    console.log(`Adding data producer with custom ID: ${id}`);
    console.log(`Data producer details: { id: ${dataProducer.id}, closed: ${dataProducer.closed}, label: ${dataProducer.label}, protocol: ${dataProducer.protocol} }`);
    this.dataProducers.set(id, dataProducer);
    
    // Log the current map of data producers to help with debugging
    console.log(`Current data producers (${this.dataProducers.size}): [${Array.from(this.dataProducers.keys()).join(', ')}]`);
  }

  // Get a specific data producer by ID
  getDataProducer(id: string) {
    const dataProducer = this.dataProducers.get(id);
    if (!dataProducer) {
      console.log(`Data producer not found: ${id}`);
      console.log(`Available data producers: [${Array.from(this.dataProducers.keys()).join(', ')}]`);
    } else {
      console.log(`Found data producer ${id}`);
    }
    return dataProducer;
  }

  // Get all data producers
  getDataProducers() {
    return this.dataProducers;
  }

  // Associate a socket with a stream ID
  setSocketStreamId(socketId: string, streamId: string) {
    this.socketToStreamId.set(socketId, streamId);
  }

  // Get the stream ID for a socket
  getSocketStreamId(socketId: string) {
    return this.socketToStreamId.get(socketId);
  }

  async consume(transportId: string, producerId: string, rtpCapabilities: mediasoup.types.RtpCapabilities) {
    console.log(`Creating consumer for producer ${producerId} on transport ${transportId}`);
    const transport = this.transports.get(transportId);
    if (!transport) {
      throw new Error(`Transport ${transportId} not found`);
    }

    const producer = this.producers.get(producerId);
    if (!producer) {
      throw new Error(`Producer ${producerId} not found`);
    }

    if (!this.router!.canConsume({ producerId, rtpCapabilities })) {
      throw new Error('Cannot consume');
    }

    try {
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: false,
      });

      console.log(`Consumer ${consumer.id} created for producer ${producerId}`);

      return {
        id: consumer.id,
        producerId: producer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      };
    } catch (error) {
      console.error(`Error creating consumer for producer ${producerId}:`, error);
      throw error;
    }
  }

  cleanup(socketId: string) {
    console.log(`Cleaning up resources for socket ${socketId}`);
    
    // Clean up any associated stream ID
    this.socketToStreamId.delete(socketId);
    
    // Get the transport ID for this socket
    const transportId = this.socketToTransport.get(socketId);
    if (transportId) {
      console.log(`Closing transport ${transportId}`);
      const transport = this.transports.get(transportId);
      if (transport) {
        transport.close();
        this.transports.delete(transportId);
      }
      this.socketToTransport.delete(socketId);
    }
    // Check if any producers need to be deleted
    for (const [producerId, producer] of this.producers.entries()) {
      if (producer.appData?.socketId === socketId) {
        console.log(`Closing producer ${producerId} for socket ${socketId}`);
        producer.close();
        this.producers.delete(producerId);
      }
    }
  }

  // Add a method to listen for data producer messages
  setupDataProducerListeners(dataProducer: DataProducer, streamId: string) {
    console.log(`Setting up data producer listeners for ${dataProducer.id}`);
    
    dataProducer.on('transportclose', () => {
      console.log(`Data producer ${dataProducer.id} closed due to transport close`);
      this.dataProducers.delete(dataProducer.id);
    });
    
    // Use observer for other events
    dataProducer.observer.on('close', () => {
      console.log(`Data producer ${dataProducer.id} closed`);
      this.dataProducers.delete(dataProducer.id);
    });
    
    // Store the association of this data producer with its stream ID
    dataProducer.appData = { ...dataProducer.appData, streamId };
    
    // Note: In mediasoup, DataProducer doesn't emit 'message' events directly
    // Messages are handled through DataConsumer.on('message') handlers
    console.log(`Data producer ${dataProducer.id} ready to receive messages for stream ${streamId}`);
  }
  
  // Helper to broadcast messages to data consumers for a specific stream
  broadcastMessageToStream(streamId: string, message: Record<string, unknown>): void {
    console.log(`Broadcasting message to consumers for stream ${streamId}`);
    
    // Get the data producer ID for this stream
    const dataProducerId = `${streamId}-data`;
    const dataProducer = this.dataProducers.get(dataProducerId);
    
    if (!dataProducer) {
      console.error(`Data producer not found for stream ${streamId}`);
      return;
    }
    
    // Prepare the message
    const serializedMsg = JSON.stringify(message);
    const buffer = Buffer.from(serializedMsg);
    
    try {
      // In mediasoup, we send through the producer to reach all consumers
      dataProducer.send(buffer);
      console.log(`Message sent through data producer ${dataProducerId}`);
    } catch (error) {
      console.error(`Failed to broadcast message to stream ${streamId}:`, error);
    }
  }

  closeAll() {
    console.log('Closing all Mediasoup resources');
    for (const transport of this.transports.values()) {
      transport.close();
    }
    this.transports.clear();
    this.socketToTransport.clear();
    this.producers.clear();
    
    if (this.worker) {
      this.worker.close();
      this.worker = null;
    }
  }
}