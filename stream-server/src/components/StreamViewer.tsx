import React, { useEffect, useRef, useState } from 'react';
import { Device } from 'mediasoup-client';
import { RtpCapabilities, Transport, Consumer, DtlsParameters, TransportOptions, RtpParameters, DataConsumer, AppData } from 'mediasoup-client/lib/types';
import { io, Socket } from 'socket.io-client';
import { Button } from '@/components/ui/button';

interface StreamViewerProps {
  streamId: string;
  onBack: () => void;
}

// Interface for server responses that might include errors
interface ServerResponse {
  error?: string;
  success?: boolean;
}

// Extend TransportOptions to include potential error
interface TransportResponse extends TransportOptions, ServerResponse {}

// Interface for consume response
interface ConsumeResponse extends ServerResponse {
  id?: string;
  producerId?: string;
  kind?: string;
  rtpParameters?: RtpParameters;
}

// Interface for chat messages
interface ChatMessage {
  sender: string;
  content: string;
  timestamp: number;
}

// Interface for data consume response
interface DataConsumeResponse extends ServerResponse {
  id: string;
  dataProducerId: string;
  sctpStreamParameters: Record<string, unknown>;
  label: string;
  protocol: string;
  fallback?: boolean;
  streamId?: string;
}

export const StreamViewer: React.FC<StreamViewerProps> = ({ streamId, onBack }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const deviceRef = useRef<Device | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const consumerTransportRef = useRef<Transport | null>(null);
  const consumerRef = useRef<Consumer | null>(null);
  const dataConsumerRef = useRef<DataConsumer<AppData> | null>(null);
  const [username] = useState<string>(`Viewer-${Math.floor(Math.random() * 1000)}`);
  const [chatMessage, setChatMessage] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isChatConnected, setIsChatConnected] = useState<boolean>(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    console.log('[StreamViewer] Initializing with streamId:', streamId);
    
    const init = async () => {
      try {
        // Connect to the server
        console.log('[StreamViewer] Connecting to server at http://localhost:3001');
        socketRef.current = io('http://localhost:3001');
        
        socketRef.current.on('connect', () => {
          console.log('[StreamViewer] Connected to server with socket ID:', socketRef.current?.id);
        });
        
        socketRef.current.on('disconnect', (reason) => {
          console.log('[StreamViewer] Disconnected from server, reason:', reason);
        });
        
        socketRef.current.on('connect_error', (err) => {
          console.error('[StreamViewer] Connection error:', err);
        });
        
        // Listen for chat messages broadcast from the server
        socketRef.current.on('broadcastChatMessage', (data: { streamId: string, message: ChatMessage }) => {
          console.log('[StreamViewer] Received broadcast chat message:', data);
          // Only process messages for our stream
          if (data.streamId === streamId) {
            setMessages((prev) => [...prev, data.message]);
          }
        });
        
        console.log('[StreamViewer] Creating mediasoup Device');
        deviceRef.current = new Device();

        // Get router RTP capabilities
        console.log('[StreamViewer] Getting router RTP capabilities');
        const routerRtpCapabilities = await new Promise<RtpCapabilities>((resolve) => {
          socketRef.current!.emit('getRouterRtpCapabilities', (data: RtpCapabilities) => {
            console.log('[StreamViewer] Received RTP capabilities:', data);
            resolve(data);
          });
        });

        // Load the device
        console.log('[StreamViewer] Loading device with RTP capabilities');
        await deviceRef.current.load({ routerRtpCapabilities });
        console.log('[StreamViewer] Device loaded successfully');

        // Create consumer transport
        console.log('[StreamViewer] Creating consumer transport');
        const transportInfo = await new Promise<TransportOptions>((resolve, reject) => {
          socketRef.current!.emit('createConsumerTransport', (data: TransportResponse) => {
            console.log('[StreamViewer] Received consumer transport info:', data);
            if (data.error) {
              console.error('[StreamViewer] Transport creation error:', data.error);
              reject(new Error(data.error));
              return;
            }
            resolve(data as unknown as TransportOptions);
          });
        });

        console.log('[StreamViewer] Creating receive transport with ID:', transportInfo.id);
        consumerTransportRef.current = deviceRef.current.createRecvTransport(transportInfo);
        console.log('[StreamViewer] Receive transport created successfully');

        // Connect transport
        consumerTransportRef.current.on('connect', async ({ dtlsParameters }: { dtlsParameters: DtlsParameters }, callback: () => void) => {
          console.log('[StreamViewer] Transport connect event, dtlsParameters:', dtlsParameters);
          socketRef.current!.emit('connectConsumerTransport', {
            transportId: consumerTransportRef.current!.id,
            dtlsParameters,
          }, (response: ServerResponse) => {
            console.log('[StreamViewer] Consumer transport connect response:', response);
            if (response.error) {
              console.error('[StreamViewer] Transport connect error:', response.error);
              return;
            }
            callback();
          });
        });
        
        consumerTransportRef.current.on('connectionstatechange', (state: string) => {
          console.log(`[StreamViewer] Consumer transport connection state changed to ${state}`);
          if (state === 'failed') {
            console.error('[StreamViewer] Transport connection failed');
          }
        });

        // Start consuming the stream
        console.log(`[StreamViewer] Requesting to consume producer ${streamId}`);
        const consumeResult = await new Promise<ConsumeResponse>((resolve) => {
          socketRef.current!.emit('consume', {
            transportId: consumerTransportRef.current!.id,
            producerId: streamId,
            rtpCapabilities: deviceRef.current!.rtpCapabilities,
          }, (data: ConsumeResponse) => {
            console.log('[StreamViewer] Consume response:', data);
            resolve(data);
          });
        });
        
        if (consumeResult.error) {
          console.error('[StreamViewer] Error consuming stream:', consumeResult.error);
          throw new Error(consumeResult.error);
        }
        
        if (!consumeResult.rtpParameters) {
          console.error('[StreamViewer] No RTP parameters received');
          throw new Error('No RTP parameters received');
        }

        console.log('[StreamViewer] Creating consumer with params:', {
          id: streamId,
          producerId: streamId,
          kind: 'video',
          rtpParameters: consumeResult.rtpParameters
        });
        
        consumerRef.current = await consumerTransportRef.current.consume({
          id: streamId,
          producerId: streamId,
          kind: 'video',
          rtpParameters: consumeResult.rtpParameters,
        });
        
        console.log('[StreamViewer] Consumer created:', consumerRef.current.id);

        consumerRef.current.on('transportclose', () => {
          console.log('[StreamViewer] Consumer transport closed');
        });
        
        consumerRef.current.on('trackended', () => {
          console.log('[StreamViewer] Consumer track ended');
        });

        console.log('[StreamViewer] Creating MediaStream from track');
        const stream = new MediaStream([consumerRef.current.track]);
        console.log('[StreamViewer] Stream created:', stream, 'with tracks:', stream.getTracks());
        
        if (videoRef.current) {
          console.log('[StreamViewer] Setting video srcObject');
          videoRef.current.srcObject = stream;
          
          videoRef.current.onloadedmetadata = () => {
            console.log('[StreamViewer] Video metadata loaded');
          };
          
          videoRef.current.onplay = () => {
            console.log('[StreamViewer] Video playback started');
          };
          
          videoRef.current.onerror = (event) => {
            console.error('[StreamViewer] Video element error:', event);
          };
          
          try {
            console.log('[StreamViewer] Playing video');
            await videoRef.current.play();
            console.log('[StreamViewer] Video playback initiated');
          } catch (error) {
            console.error('[StreamViewer] Error playing video:', error);
          }
        } else {
          console.error('[StreamViewer] Video element reference not available');
        }

        // After setting up video consumer, set up data consumer
        try {
          console.log('[StreamViewer] Setting up data consumer');
          await setupDataConsumer();
        } catch (dataError) {
          console.error('[StreamViewer] Error setting up data consumer:', dataError);
          // Don't fail the whole connection, just the chat functionality
        }

      } catch (error) {
        console.error('[StreamViewer] Error initializing stream viewer:', error);
      }
    };

    const setupDataConsumer = async () => {
      if (!consumerTransportRef.current || !deviceRef.current || !socketRef.current) {
        console.error('[StreamViewer] Cannot setup data consumer: required references not available');
        setIsChatConnected(true); // Still set chat as connected to use socket.io fallback
        return;
      }

      try {
        // Request to consume data from the producer
        console.log('[StreamViewer] Requesting to consume data from producer');
        const dataConsumeResult = await new Promise<DataConsumeResponse>((resolve, reject) => {
          socketRef.current!.emit('consumeData', {
            transportId: consumerTransportRef.current!.id,
            dataProducerId: `${streamId}-data`, // Assuming this naming convention for data producers
          }, (data: DataConsumeResponse) => {
            console.log('[StreamViewer] ConsumeData response:', data);
            if (data.error) {
              // If this is a fallback error, we still want to resolve
              if (data.fallback) {
                console.log('[StreamViewer] Using socket.io fallback for chat');
                resolve({
                  ...data,
                  error: undefined // Clear the error so we don't throw later
                } as DataConsumeResponse);
                return;
              }
              
              reject(new Error(data.error));
              return;
            }
            resolve(data);
          });
        });

        // If we got a fallback response, just set chat as connected and return
        if (dataConsumeResult.fallback) {
          console.log('[StreamViewer] Using socket.io fallback for chat as indicated by server');
          setIsChatConnected(true);
          return;
        }

        console.log('[StreamViewer] Creating data consumer with params:', dataConsumeResult);
        dataConsumerRef.current = await consumerTransportRef.current.consumeData({
          id: dataConsumeResult.id,
          dataProducerId: dataConsumeResult.dataProducerId,
          sctpStreamParameters: dataConsumeResult.sctpStreamParameters,
          label: dataConsumeResult.label,
          protocol: dataConsumeResult.protocol,
        });

        console.log('[StreamViewer] Data consumer created:', dataConsumerRef.current.id);
        
        // Access the underlying RTCDataChannel
        const dataConsumer = dataConsumerRef.current;
        if (dataConsumer) {
          // Use the 'on' method to listen for messages
          dataConsumer.on('message', (data: ArrayBuffer) => {
            console.log('[StreamViewer] Data consumer message received');
            try {
              const decodedData = new TextDecoder().decode(data);
              const message: ChatMessage = JSON.parse(decodedData);
              setMessages((prev) => [...prev, message]);
            } catch (e) {
              console.error('[StreamViewer] Error parsing message:', e);
            }
          });

          dataConsumer.on('open', () => {
            console.log('[StreamViewer] Data consumer opened');
            setIsChatConnected(true);
          });

          dataConsumer.on('close', () => {
            console.log('[StreamViewer] Data consumer closed');
            setIsChatConnected(false);
          });
        }
      } catch (error) {
        console.error('[StreamViewer] Error setting up data consumer:', error);
        // Set chat as connected anyway since we'll fallback to socket.io
        setIsChatConnected(true);
      }
    };

    init();

    return () => {
      console.log('[StreamViewer] Cleaning up resources');
      if (dataConsumerRef.current) {
        console.log('[StreamViewer] Closing data consumer');
        dataConsumerRef.current.close();
      }
      if (consumerRef.current) {
        console.log('[StreamViewer] Closing consumer');
        consumerRef.current.close();
      }
      if (consumerTransportRef.current) {
        console.log('[StreamViewer] Closing consumer transport');
        consumerTransportRef.current.close();
      }
      if (socketRef.current) {
        console.log('[StreamViewer] Disconnecting socket');
        socketRef.current.disconnect();
      }
    };
  }, [streamId]);

  const sendMessage = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!chatMessage.trim()) {
      return;
    }

    const message: ChatMessage = {
      sender: username,
      content: chatMessage.trim(),
      timestamp: Date.now(),
    };

    try {
      // Always use socket.io to send chat messages for reliability
      if (socketRef.current) {
        socketRef.current.emit('chatMessage', {
          streamId,
          message,
        });
        
        // Add the message to our local state
        setMessages((prev) => [...prev, message]);
        setChatMessage('');
      }
    } catch (error) {
      console.error('[StreamViewer] Error sending message:', error);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4 p-4 w-full max-w-7xl mx-auto">
      <div className="flex flex-col items-center gap-4 lg:w-2/3">
        <h2 className="text-xl font-bold mb-2">Stream: {streamId}</h2>
        <video
          ref={videoRef}
          className="w-full aspect-video bg-black rounded-lg"
          playsInline
          controls
        />
        <Button onClick={onBack} variant="outline">
          Back to Streams
        </Button>
      </div>
      
      <div className="lg:w-1/3 h-[600px] flex flex-col bg-white shadow-md rounded-lg">
        <div className="p-4 border-b">
          <h3 className="font-medium">Chat</h3>
        </div>
        <div className="flex-grow overflow-y-auto p-4">
          <div className="space-y-2">
            {messages.map((msg, index) => (
              <div
                key={index}
                className={`p-2 rounded-lg ${
                  msg.sender === username ? 'bg-blue-100 ml-auto' : 'bg-gray-100'
                } max-w-[80%] break-words`}
              >
                <div className="text-xs text-gray-500">{msg.sender}</div>
                <div className="text-sm">{msg.content}</div>
                <div className="text-xs text-gray-500">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>
        <div className="p-4 border-t">
          <form onSubmit={sendMessage} className="flex w-full gap-2">
            <input
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 flex-1"
              value={chatMessage}
              onChange={(e) => setChatMessage(e.target.value)}
              placeholder={isChatConnected ? "Type a message..." : "Chat connecting..."}
              disabled={!isChatConnected}
            />
            <Button 
              type="submit" 
              disabled={!isChatConnected || !chatMessage.trim()}
            >
              Send
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}; 