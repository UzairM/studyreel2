import os
import logging
import base64
import io
import time
import json
import asyncio
from typing import Dict, Any, List, Optional
from datetime import datetime
import cv2
import numpy as np
from PIL import Image
from openai import AsyncOpenAI

logger = logging.getLogger(__name__)

class GPTAnalyzer:
    def __init__(
        self, 
        api_key: str, 
        model: str = "gpt-4o", 
        max_history: int = 10,
        analysis_interval: int = 5
    ):
        """
        Initialize the GPT Analyzer for OCR and event detection.
        
        Args:
            api_key: OpenAI API key
            model: GPT model to use
            max_history: Maximum number of frames to keep in history
            analysis_interval: Analyze every X frames
        """
        self.client = AsyncOpenAI(api_key=api_key)
        self.model = model
        self.max_history = max_history
        self.analysis_interval = analysis_interval
        
        # Frame history for context
        self.frame_history = []
        self.frame_count = 0
        
        # Event history
        self.detected_events = []
        
        # Implementation plan for context
        self.implementation_plan = self._load_implementation_plan()
        
        logger.info(f"GPT Analyzer initialized with model {model}")
        
    def _load_implementation_plan(self) -> str:
        """Load the implementation plan from file if available"""
        try:
            plan_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "implementation_plan.md")
            if os.path.exists(plan_path):
                with open(plan_path, 'r') as f:
                    return f.read()
            else:
                logger.warning(f"Implementation plan not found at {plan_path}")
                return ""
        except Exception as e:
            logger.error(f"Error loading implementation plan: {e}")
            return ""
            
    def _encode_image(self, image_array: np.ndarray) -> str:
        """Convert a numpy array to a base64 encoded image"""
        # Convert from BGR to RGB (OpenCV uses BGR by default)
        if len(image_array.shape) == 3 and image_array.shape[2] == 3:
            image_array = cv2.cvtColor(image_array, cv2.COLOR_BGR2RGB)
            
        # Convert to PIL Image
        pil_image = Image.fromarray(image_array)
        
        # Save to bytes buffer
        buffer = io.BytesIO()
        pil_image.save(buffer, format="JPEG")
        buffer.seek(0)
        
        # Encode to base64
        encoded = base64.b64encode(buffer.getvalue()).decode('utf-8')
        return encoded
        
    async def analyze_frame(self, frame: np.ndarray, metadata: Dict[str, Any]) -> Dict[str, Any]:
        """
        Analyze a frame using GPT-4o for OCR and event detection.
        
        Args:
            frame: The video frame as a numpy array
            metadata: Additional information about the frame
            
        Returns:
            Dict containing analysis results
        """
        self.frame_count += 1
        
        # Only analyze every X frames to avoid API rate limits
        if self.frame_count % self.analysis_interval != 0:
            return {"analyzed": False}
            
        # Add timestamp to metadata
        metadata["timestamp"] = datetime.now().isoformat()
        
        # Encode the image
        encoded_image = self._encode_image(frame)
        
        # Add to frame history with basic metadata
        self.frame_history.append({
            "timestamp": metadata["timestamp"],
            "stream_id": metadata.get("stream_id", "unknown"),
            "frame_number": self.frame_count
        })
        
        # Keep only the most recent frames
        if len(self.frame_history) > self.max_history:
            self.frame_history.pop(0)
            
        # Create the prompt for GPT-4o
        system_prompt = self._create_system_prompt()
        user_prompt = self._create_user_prompt(metadata)
        
        try:
            # Call GPT-4o API with the image
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": [
                        {"type": "text", "text": user_prompt},
                        {"type": "image_url", 
                         "image_url": {"url": f"data:image/jpeg;base64,{encoded_image}"}}
                    ]}
                ],
                max_tokens=1000
            )
            
            # Parse the response
            result = self._parse_gpt_response(response.choices[0].message.content)
            
            # Add to event history if events were detected
            if "events" in result and result["events"]:
                for event in result["events"]:
                    event["timestamp"] = metadata["timestamp"]
                    self.detected_events.append(event)
                    
                # Keep only recent events
                if len(self.detected_events) > 50:
                    self.detected_events = self.detected_events[-50:]
                    
            # Add analysis metadata
            result["analyzed"] = True
            result["frame_number"] = self.frame_count
            result["analysis_time"] = datetime.now().isoformat()
            
            logger.info(f"Frame {self.frame_count} analyzed: {len(result.get('events', [])) or 0} events detected")
            return result
            
        except Exception as e:
            logger.error(f"Error analyzing frame with GPT-4o: {e}", exc_info=True)
            return {
                "analyzed": False,
                "error": str(e),
                "frame_number": self.frame_count
            }
            
    def _create_system_prompt(self) -> str:
        """Create the system prompt for GPT-4o"""
        prompt = """You are an AI assistant specialized in analyzing student activity from video streams. 
Your task is to perform OCR (extract text from the screen) and detect events based on the implementation plan.

For each frame, you should:
1. Extract all visible text from the screen (OCR)
2. Identify the application being used
3. Detect student events according to the implementation plan
4. Determine if the student is active or inactive
5. Identify any anti-patterns (e.g., idling, cheating) or speed bumps (e.g., rushing)

Respond with a JSON object containing:
- "ocr_text": All text visible on the screen
- "app_detected": The application identified
- "events": Array of events detected
- "activity_status": "active" or "inactive"
- "anti_patterns": Array of anti-patterns detected
- "speed_bumps": Array of speed bumps detected

Each event should have:
- "type": The event type
- "confidence": Your confidence level (0-1)
- "details": Additional information

Be precise and focus on high-confidence detections (>0.8).
"""

        # Add implementation plan if available
        if self.implementation_plan:
            prompt += "\n\nHere is the implementation plan to guide your analysis:\n\n"
            # Truncate if too long
            if len(self.implementation_plan) > 2000:
                prompt += self.implementation_plan[:2000] + "...(truncated)"
            else:
                prompt += self.implementation_plan
                
        return prompt
        
    def _create_user_prompt(self, metadata: Dict[str, Any]) -> str:
        """Create the user prompt for GPT-4o"""
        prompt = f"""Analyze this frame from stream {metadata.get('stream_id', 'unknown')}.

Context:
- Frame number: {self.frame_count}
- Timestamp: {metadata.get('timestamp', 'unknown')}
- Stream ID: {metadata.get('stream_id', 'unknown')}
"""

        # Add frame history context if available
        if self.frame_history and len(self.frame_history) > 1:
            prompt += "\nRecent activity:\n"
            for i, hist in enumerate(self.frame_history[-5:]):
                prompt += f"- Frame {hist['frame_number']} at {hist['timestamp']}\n"
                
        # Add recent events if available
        if self.detected_events:
            prompt += "\nRecent events detected:\n"
            for i, event in enumerate(self.detected_events[-3:]):
                prompt += f"- {event.get('type', 'unknown')} ({event.get('confidence', 0):.2f}): {event.get('details', '')}\n"
                
        prompt += "\nPlease analyze this frame and return the JSON response as specified."
        return prompt
        
    def _parse_gpt_response(self, response_text: str) -> Dict[str, Any]:
        """Parse the GPT response text into a structured format"""
        try:
            # Extract JSON from the response
            json_start = response_text.find('{')
            json_end = response_text.rfind('}')
            
            if json_start >= 0 and json_end >= 0:
                json_str = response_text[json_start:json_end+1]
                result = json.loads(json_str)
                return result
            else:
                # Try to parse the whole response as JSON
                return json.loads(response_text)
                
        except json.JSONDecodeError:
            logger.warning(f"Could not parse GPT response as JSON: {response_text[:100]}...")
            
            # Return a basic structure with the raw text
            return {
                "ocr_text": "Error parsing response",
                "raw_response": response_text,
                "events": []
            }
            
    def get_event_history(self) -> List[Dict[str, Any]]:
        """Get the history of detected events"""
        return self.detected_events
        
    def get_stats(self) -> Dict[str, Any]:
        """Get analyzer statistics"""
        return {
            "frames_analyzed": self.frame_count // self.analysis_interval,
            "total_frames": self.frame_count,
            "events_detected": len(self.detected_events)
        } 