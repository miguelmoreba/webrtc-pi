## To test in dev

1. Clone this repo in your pi
2. Run
   ```
   docker build -t webrtc-pi-streaming .
   ```
3. Run
   ```
   docker run --name webrtc-pi --network="host" webrtc-pi-stream
   ```

## When a new version is available

   Run
   ```
   docker stop webrtc-pi
   ```
   Then repeat steps above