# SSH
ssh -i "Nanoclaw Jaime Keypair.pem" ec2-user@ec2-3-138-61-249.us-east-2.compute.amazonaws.com

# Installing Docker:
https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-docker.html

# Installing Node.js:
https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/setting-up-node-on-ec2-instance.html

# Installing Claude Code
npm install -g @anthropic-ai/claude-code

# Install Git
sudo yum install git -y

# Install NanoClaw:
- Fork NanoClaw repo on GitHub
- git clone https://github.com/<my-user>/nanoclaw
- cd nanoclaw
- claude
- /setup

https://www.thesys.dev/blogs/nanoclaw

> Got it. Setup is complete!                                                   
> Summary:                                                                     
>   - ✓ Node.js 24, build tools, dependencies installed                          
>   - ✓ Docker container built and tested                                        
>   - ✓ Claude auth configured                                                   
>   - ✓ WhatsApp authenticated — registered as self-chat, assistant name Chloe, trigger @Chloe (not required for self-chat)
>   - ✓ Service running via systemd                                              
>                                                                                
>   To test: Send yourself a message in WhatsApp's "Message Yourself" conversation — Chloe should respond.
> 
>   To check logs: tail -f logs/nanoclaw.log
> 
>   To add Slack later: just say /add-slack

# Configure NanoClaw

`/customize`

# Additional Setup
- Need to run `sudo loginctl enable-linger ec2-user` so nanoclaw doesn't stop after SSH