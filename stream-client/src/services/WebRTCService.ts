import * as mediasoupClient from 'mediasoup-client';
import { io, Socket } from 'socket.io-client';
import { Device, RtpCapabilities, TransportOptions } from 'mediasoup-client/lib/types';
import { ChatMessage, StreamConfig } from '../types';

// Extend the TransportOptions type to include possible error responses
interface ServerResponse {
  error?: string;
}

// Socket.IO error interfaces
interface SocketIOError extends Error {
  description?: string;
  context?: any;
}

interface DisconnectDetails {
  message?: string;
  description?: string;
  context?: any;
}

// Define complete response types
interface TransportResponse extends ServerResponse {
  id: string;
  iceParameters: any;
  iceCandidates: any;
  dtlsParameters: any;
  error?: string;
}

interface ProduceResponse {
  id: string;
  error?: string;
}

export class WebRTCService {
  private device: Device | null = null;
  private socket: Socket | null = null;
  private producerTransport: any = null;
  private videoProducer: any = null;
  private dataProducer: any = null;
  private dataChannel: RTCDataChannel | null = null;
  private onChatMessage: ((message: ChatMessage) => void) | null = null;

  constructor() {
    console.log('[WebRTCService] Initializing');
    this.device = new mediasoupClient.Device();
  }

  async connect(config: StreamConfig): Promise<void> {
    console.log('[WebRTCService] Connecting to server:', config.serverUrl);
    this.socket = io(config.serverUrl, {
      reconnectionAttempts: 5,
      timeout: 10000,
      transports: ['websocket', 'polling']
    });

    // Handle socket connection
    return new Promise((resolve, reject) => {
      this.socket!.on('connect', async () => {
        console.log('[WebRTCService] Connected to server with socket ID:', this.socket!.id);
        try {
          // Get router RTP capabilities
          console.log('[WebRTCService] Getting router RTP capabilities');
          const routerRtpCapabilities = await new Promise<RtpCapabilities>((resolve, reject) => {
            this.socket!.emit('getRouterRtpCapabilities', (data: any) => {
              console.log('[WebRTCService] Received RTP capabilities:', data);
              if (data && data.error) {
                console.error('[WebRTCService] Error getting RTP capabilities:', data.error);
                reject(new Error(data.error));
                return;
              }
              resolve(data as RtpCapabilities);
            });

            // Add timeout for the emit call
            setTimeout(() => {
              reject(new Error('Timeout waiting for RTP capabilities'));
            }, 5000);
          });
          
          console.log('[WebRTCService] Loading device with RTP capabilities');
          await this.device!.load({ routerRtpCapabilities });
          console.log('[WebRTCService] Device loaded successfully');
          
          // Create transport
          console.log('[WebRTCService] Creating send transport');
          await this.createSendTransport();
          console.log('[WebRTCService] Send transport created successfully');
          
          resolve();
        } catch (error) {
          console.error('[WebRTCService] Connection error:', error);
          reject(error);
        }
      });

      this.socket!.on('connect_error', (err: SocketIOError) => {
        console.error('[WebRTCService] Socket.IO connect_error:', err);
        console.error('[WebRTCService] Connect error details:', {
          message: err.message,
          description: err.description,
          context: err.context
        });
        reject(new Error(`Socket.IO connection error: ${err.message}`));
      });

      this.socket!.on('error', (err) => {
        console.error('[WebRTCService] Socket error:', err);
        reject(err);
      });

      this.socket!.on('disconnect', (reason: string, details?: DisconnectDetails) => {
        console.log('[WebRTCService] Disconnected from server, reason:', reason);
        if (details) {
          console.log('[WebRTCService] Disconnect details:', {
            message: details.message,
            description: details.description,
            context: details.context
          });
        }
      });

      this.socket!.on('connect_timeout', (timeout) => {
        console.error('[WebRTCService] Connection timeout after', timeout);
        reject(new Error(`Connection timeout after ${timeout}ms`));
      });

      // Add a timeout for the entire connection process
      setTimeout(() => {
        if (!this.socket?.connected) {
          console.error('[WebRTCService] Connection timed out');
          reject(new Error('Connection timed out'));
        }
      }, 10000);
    });
  }

  private async createSendTransport(): Promise<void> {
    console.log('[WebRTCService] Requesting producer transport from server');
    const transportInfo = await new Promise<TransportOptions>((resolve, reject) => {
      this.socket!.emit('createProducerTransport', {
        forceTcp: false,
        rtpCapabilities: this.device!.rtpCapabilities,
      }, (data: TransportResponse) => {
        console.log('[WebRTCService] Received transport info:', data);
        if (data.error) {
          console.error('[WebRTCService] Transport creation error:', data.error);
          reject(new Error(data.error));
          return;
        }
        // Cast to TransportOptions to satisfy the type constraint
        resolve(data as unknown as TransportOptions);
      });
    });

    console.log('[WebRTCService] Creating send transport with ID:', transportInfo.id);
    this.producerTransport = this.device!.createSendTransport(transportInfo);
    console.log('[WebRTCService] Send transport created with ID:', this.producerTransport.id);

    this.producerTransport.on('connect', async ({ dtlsParameters }: any, callback: () => void, errback: (error: Error) => void) => {
      console.log('[WebRTCService] Transport connect event, dtlsParameters:', dtlsParameters);
      try {
        await new Promise<void>((resolve, reject) => {
          this.socket!.emit('connectProducerTransport', { dtlsParameters }, (response: ServerResponse) => {
            console.log('[WebRTCService] Producer transport connect response:', response);
            if (response.error) {
              console.error('[WebRTCService] Transport connect error:', response.error);
              reject(new Error(response.error));
              return;
            }
            resolve();
          });
        });
        console.log('[WebRTCService] Producer transport connected successfully');
        callback();
      } catch (error) {
        console.error('[WebRTCService] Failed to connect producer transport:', error);
        errback(error instanceof Error ? error : new Error('Failed to connect transport'));
      }
    });

    this.producerTransport.on('produce', async ({ kind, rtpParameters }: any, callback: (id: string) => void, errback: (error: Error) => void) => {
      console.log(`[WebRTCService] Transport produce event, kind: ${kind}`);
      console.log('[WebRTCService] RTP parameters:', rtpParameters);
      
      try {
        const { id } = await new Promise<{id: string}>((resolve, reject) => {
          this.socket!.emit('produce', {
            transportId: this.producerTransport.id,
            kind,
            rtpParameters,
          }, (data: ProduceResponse) => {
            console.log('[WebRTCService] Produce response:', data);
            if (data.error) {
              console.error('[WebRTCService] Produce error:', data.error);
              reject(new Error(data.error));
              return;
            }
            resolve({ id: data.id });
          });
        });
        
        console.log(`[WebRTCService] Producer created with ID: ${id}`);
        callback(id);
      } catch (error) {
        console.error('[WebRTCService] Failed to produce:', error);
        errback(error instanceof Error ? error : new Error('Failed to produce'));
      }
    });

    this.producerTransport.on('connectionstatechange', (state: string) => {
      console.log(`[WebRTCService] Producer transport connection state changed to ${state}`);
      if (state === 'failed') {
        console.error('[WebRTCService] Transport connection failed');
        this.producerTransport.close();
      }
    });
  }

  async startStreaming(videoFile: File): Promise<void> {
    console.log(`[WebRTCService] Starting streaming of file: ${videoFile.name}, size: ${videoFile.size}, type: ${videoFile.type}`);
    try {
      // Validate if the transport is ready
      if (!this.producerTransport) {
        console.error('[WebRTCService] No producer transport available');
        throw new Error('No producer transport available');
      }
      
      // Check transport state
      console.log('[WebRTCService] Producer transport state:', this.producerTransport.connectionState);
      
      const stream = await this.createStreamFromFile(videoFile);
      console.log('[WebRTCService] Stream created from file:', stream);
      
      const tracks = stream.getVideoTracks();
      console.log('[WebRTCService] Video tracks:', tracks);
      
      if (tracks.length === 0) {
        console.error('[WebRTCService] No video tracks found in the stream');
        throw new Error('No video tracks found in the stream');
      }
      
      const track = tracks[0];
      console.log('[WebRTCService] Using video track:', track.label, track.id, 'enabled:', track.enabled, 'readyState:', track.readyState);
      
      if (track.readyState !== 'live') {
        console.warn('[WebRTCService] Video track is not live, attempting to fix...');
        // Try to ensure the track is active
        if (!track.enabled) track.enabled = true;
      }
      
      // Create producer with single encoding for simplicity
      console.log('[WebRTCService] Creating video producer with simpler parameters');
      this.videoProducer = await this.producerTransport.produce({
        track,
        encodings: [
          { maxBitrate: 500000 }
        ],
        codecOptions: {
          videoGoogleStartBitrate: 1000
        }
      });
      
      console.log('[WebRTCService] Video producer created with ID:', this.videoProducer.id);
      
      this.videoProducer.on('transportclose', () => {
        console.log('[WebRTCService] Video producer transport closed');
      });
      
      this.videoProducer.on('trackended', () => {
        console.log('[WebRTCService] Video track ended');
      });
      
      // Force periodic check for server-side producers to ensure our producer is registered
      this.checkProducers();
    } catch (error) {
      console.error('[WebRTCService] Error starting streaming:', error);
      throw error;
    }
  }

  // Add new method to periodically check producers
  private checkProducers(): void {
    console.log('[WebRTCService] Starting producer check interval');
    const checkInterval = setInterval(() => {
      if (!this.socket) {
        clearInterval(checkInterval);
        return;
      }
      
      this.socket.emit('getProducers', (producers: any[]) => {
        console.log('[WebRTCService] Current producers on server:', producers);
        if (producers.length === 0 && this.videoProducer) {
          console.warn('[WebRTCService] Producer not found on server, attempting to recreate');
          // Producer might not have been created correctly, try again
          this.socket!.emit('produce', {
            kind: 'video',
            rtpParameters: this.videoProducer.rtpParameters,
          }, (response: ProduceResponse) => {
            console.log('[WebRTCService] Produce retry response:', response);
          });
        } else if (producers.length > 0) {
          console.log('[WebRTCService] Found producers on server, stopping check interval');
          clearInterval(checkInterval);
        }
      });
    }, 2000);
    
    // Clear interval after 30 seconds to avoid running forever
    setTimeout(() => {
      clearInterval(checkInterval);
      console.log('[WebRTCService] Stopped producer check interval');
    }, 30000);
  }

  private async createStreamFromFile(file: File): Promise<MediaStream> {
    console.log('[WebRTCService] Creating stream from file');
    const video = document.createElement('video');
    video.src = URL.createObjectURL(file);
    video.muted = true;
    video.autoplay = true; // Ensure autoplay is enabled
    video.playsInline = true; // Important for iOS
    document.body.appendChild(video); // Temporarily add to DOM for proper initialization
    
    return new Promise((resolve, reject) => {
      video.onloadedmetadata = () => {
        console.log('[WebRTCService] Video metadata loaded, duration:', video.duration, 'dimensions:', video.videoWidth, 'x', video.videoHeight);
        try {
          video.play()
            .then(() => {
              console.log('[WebRTCService] Video playback started');
              // @ts-ignore - captureStream is not in the standard types
              const stream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
              console.log('[WebRTCService] Stream captured:', stream, 'tracks:', stream.getTracks());
              
              // Keep video in the DOM to ensure the stream remains active
              video.style.position = 'fixed';
              video.style.top = '-9999px';
              video.style.left = '-9999px';
              
              resolve(stream);
            })
            .catch(err => {
              console.error('[WebRTCService] Error playing video:', err);
              document.body.removeChild(video);
              reject(err);
            });
        } catch (error) {
          console.error('[WebRTCService] Error creating stream from file:', error);
          document.body.removeChild(video);
          reject(error);
        }
      };
      
      video.onerror = (event) => {
        console.error('[WebRTCService] Error loading video:', event);
        document.body.removeChild(video);
        reject(new Error('Error loading video'));
      };
    });
  }

  async setupDataChannel(): Promise<void> {
    console.log('[WebRTCService] Setting up data channel');

    try {
      // Check if the transport exists
      if (!this.producerTransport) {
        console.error('[WebRTCService] Cannot setup data channel: no producer transport');
        throw new Error('No producer transport available');
      }

      // Check if the transport has SCTP enabled
      if (!this.producerTransport.sctpState) {
        console.warn('[WebRTCService] Transport may not have SCTP enabled, will try anyway');
      }

      console.log('[WebRTCService] Creating data producer');
      this.dataProducer = await this.producerTransport.produceData({
        ordered: true,
        maxPacketLifeTime: 5000, // 5 seconds
        label: 'chat',
        protocol: 'chat',
      });

      console.log('[WebRTCService] Data producer created with ID:', this.dataProducer.id);
      this.dataChannel = this.dataProducer._dataChannel;
      
      if (this.dataChannel) {
        console.log('[WebRTCService] Data channel setup with label:', this.dataChannel.label);
        
        this.dataChannel.onopen = () => {
          console.log('[WebRTCService] Data channel opened');
        };
        
        this.dataChannel.onclose = () => {
          console.log('[WebRTCService] Data channel closed');
        };
        
        this.dataChannel.onerror = (event) => {
          console.error('[WebRTCService] Data channel error:', event);
        };
        
        this.dataChannel.onmessage = (event) => {
          console.log('[WebRTCService] Data channel message received:', event.data);
          if (this.onChatMessage) {
            const message: ChatMessage = JSON.parse(event.data);
            this.onChatMessage(message);
          }
        };
      } else {
        console.error('[WebRTCService] Failed to create data channel');
        throw new Error('Failed to create data channel');
      }
    } catch (error) {
      console.error('[WebRTCService] Error setting up data channel:', error);
      // Don't throw here - just log the error and continue without data channel
      console.warn('[WebRTCService] Continuing without data channel');
    }
  }

  sendChatMessage(message: ChatMessage): void {
    console.log('[WebRTCService] Sending chat message:', message);
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(message));
    } else {
      console.error('[WebRTCService] Cannot send message, data channel not open');
    }
  }

  setOnChatMessage(callback: (message: ChatMessage) => void): void {
    console.log('[WebRTCService] Setting chat message callback');
    this.onChatMessage = callback;
  }

  disconnect(): void {
    console.log('[WebRTCService] Disconnecting');
    
    if (this.videoProducer) {
      console.log('[WebRTCService] Closing video producer');
      this.videoProducer.close();
    }
    
    if (this.dataProducer) {
      console.log('[WebRTCService] Closing data producer');
      this.dataProducer.close();
    }
    
    if (this.producerTransport) {
      console.log('[WebRTCService] Closing producer transport');
      this.producerTransport.close();
    }
    
    if (this.socket) {
      console.log('[WebRTCService] Disconnecting socket');
      this.socket.disconnect();
    }
    
    console.log('[WebRTCService] Disconnect complete');
  }
} 