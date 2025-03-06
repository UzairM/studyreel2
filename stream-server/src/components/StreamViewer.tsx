import React, { useEffect, useRef } from 'react';
import { Device } from 'mediasoup-client';
import { RtpCapabilities, Transport, Consumer, DtlsParameters, TransportOptions, RtpParameters } from 'mediasoup-client/lib/types';
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

export const StreamViewer: React.FC<StreamViewerProps> = ({ streamId, onBack }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const deviceRef = useRef<Device | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const consumerTransportRef = useRef<Transport | null>(null);
  const consumerRef = useRef<Consumer | null>(null);

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
      } catch (error) {
        console.error('[StreamViewer] Error initializing stream viewer:', error);
      }
    };

    init();

    return () => {
      console.log('[StreamViewer] Cleaning up resources');
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

  return (
    <div className="flex flex-col items-center gap-4 p-4">
      <h2 className="text-xl font-bold mb-2">Stream: {streamId}</h2>
      <video
        ref={videoRef}
        className="w-full max-w-4xl aspect-video bg-black rounded-lg"
        playsInline
        controls
      />
      <Button onClick={onBack} variant="outline">
        Back to Streams
      </Button>
    </div>
  );
}; 