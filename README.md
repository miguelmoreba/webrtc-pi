## To test in dev

1. Clone this repo in your pi
2. Run
   ```
   docker build -t webrtc-pi-streaming .
   ```
3. Run
   ```
   docker run --network="host" pi-stream
   ```