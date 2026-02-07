// Test script to simulate WhatsApp message
const { runContainerAgent } = require('./dist/container-runner.js');

const testGroup = {
  name: 'Test Group',
  folder: 'test-group',
  jid: 'test@g.us',
  containerConfig: {
    timeout: 30000
  }
};

const testInput = {
  prompt: 'Test the calculator skill: what is sqrt(16) + 2^3?',
  groupFolder: 'test-group',
  chatId: 'test@g.us',
  isMain: true
};

console.log('Testing with new container...');
runContainerAgent(testGroup, testInput)
  .then(result => {
    console.log('Result:', JSON.stringify(result, null, 2));
  })
  .catch(err => {
    console.error('Error:', err);
  });
