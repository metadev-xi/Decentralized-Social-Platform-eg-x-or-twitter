/**
 * Social Token Platform - Token Access Manager
 * 
 * Core functionality for the friend.tech-like platform that manages
 * access keys, private chats, and tokenized social interactions.
 */

const { ethers } = require('ethers');
const { WebSocketServer } = require('ws');

class TokenAccessManager {
  constructor(config = {}) {
    this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
    this.contractAddress = config.contractAddress;
    this.abi = require('./contracts/SocialKeyABI.json');
    this.contract = new ethers.Contract(this.contractAddress, this.abi, this.provider);
    this.chatServer = new WebSocketServer({ port: config.wsPort || 8080 });
    this.userSessions = new Map();
    this.chatRooms = new Map();
    
    // Initialize WebSocket server for private chats
    this.initChatServer();
  }

  // Get key price based on bonding curve
  async getKeyPrice(creatorAddress, action) {
    try {
      const keySupply = await this.contract.getKeySupply(creatorAddress);
      return action === 'buy' 
        ? await this.contract.getBuyPrice(creatorAddress, 1)
        : await this.contract.getSellPrice(creatorAddress, 1);
    } catch (error) {
      console.error('Error getting key price:', error);
      throw new Error(`Failed to get key price: ${error.message}`);
    }
  }

  // Buy keys for a creator
  async buyKeys(buyerWallet, creatorAddress, amount = 1) {
    try {
      const keyPrice = await this.contract.getBuyPrice(creatorAddress, amount);
      const fee = keyPrice.mul(ethers.BigNumber.from(10)).div(ethers.BigNumber.from(100)); // 10% fee
      const totalCost = keyPrice.add(fee);
      
      const signer = buyerWallet.connect(this.provider);
      const contractWithSigner = this.contract.connect(signer);
      
      const tx = await contractWithSigner.buyKeys(creatorAddress, amount, {
        value: totalCost
      });
      
      return {
        success: true,
        transaction: tx.hash,
        keyPrice: ethers.utils.formatEther(keyPrice),
        fee: ethers.utils.formatEther(fee),
        totalCost: ethers.utils.formatEther(totalCost)
      };
    } catch (error) {
      console.error('Error buying keys:', error);
      return { success: false, error: error.message };
    }
  }

  // Sell keys for a creator
  async sellKeys(sellerWallet, creatorAddress, amount = 1) {
    try {
      const signer = sellerWallet.connect(this.provider);
      const contractWithSigner = this.contract.connect(signer);
      
      const tx = await contractWithSigner.sellKeys(creatorAddress, amount);
      const keyPrice = await this.contract.getSellPrice(creatorAddress, amount);
      
      return {
        success: true,
        transaction: tx.hash,
        salePrice: ethers.utils.formatEther(keyPrice)
      };
    } catch (error) {
      console.error('Error selling keys:', error);
      return { success: false, error: error.message };
    }
  }

  // Check if a user has access to a creator's exclusive content
  async checkAccess(userAddress, creatorAddress) {
    try {
      const balance = await this.contract.keysBalance(userAddress, creatorAddress);
      return {
        hasAccess: balance.gt(0),
        keyCount: balance.toNumber()
      };
    } catch (error) {
      console.error('Error checking access:', error);
      return { hasAccess: false, error: error.message };
    }
  }

  // Initialize WebSocket server for private chats
  initChatServer() {
    this.chatServer.on('connection', (ws) => {
      let userId = null;
      let accessibleRooms = [];
      
      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message);
          
          switch (data.type) {
            case 'auth':
              // Authenticate user and get their accessible rooms
              userId = await this.authenticateUser(data.signature, data.message);
              accessibleRooms = await this.getUserAccessibleRooms(userId);
              ws.send(JSON.stringify({ 
                type: 'auth_result', 
                success: !!userId,
                accessibleRooms 
              }));
              break;
              
            case 'join_room':
              // Join a creator's private chat room
              if (!userId) {
                ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
                return;
              }
              
              const hasAccess = await this.checkAccess(userId, data.creatorAddress);
              if (!hasAccess.hasAccess) {
                ws.send(JSON.stringify({ 
                  type: 'error', 
                  message: 'You do not have access to this room. Purchase keys first.' 
                }));
                return;
              }
              
              this.addUserToRoom(ws, userId, data.creatorAddress);
              break;
              
            case 'send_message':
              // Send a message to a room
              if (!userId) {
                ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
                return;
              }
              
              this.broadcastToRoom(data.roomId, {
                type: 'new_message',
                sender: userId,
                content: data.content,
                timestamp: Date.now()
              }, ws);
              break;
          }
        } catch (error) {
          console.error('WebSocket message error:', error);
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
      });
      
      ws.on('close', () => {
        if (userId) {
          this.removeUserFromRooms(ws, userId);
        }
      });
    });
  }

  // Private methods
  async authenticateUser(signature, message) {
    try {
      const recoveredAddress = ethers.utils.verifyMessage(message, signature);
      return recoveredAddress;
    } catch (error) {
      console.error('Authentication error:', error);
      return null;
    }
  }

  async getUserAccessibleRooms(userAddress) {
    try {
      // Would typically query the blockchain for all creators the user holds keys for
      const filter = this.contract.filters.KeyPurchase(null, userAddress, null);
      const events = await this.contract.queryFilter(filter);
      
      // Deduplicate creator addresses
      const creatorSet = new Set();
      events.forEach(event => creatorSet.add(event.args.subject));
      
      return Array.from(creatorSet);
    } catch (error) {
      console.error('Error getting accessible rooms:', error);
      return [];
    }
  }

  addUserToRoom(ws, userId, roomId) {
    if (!this.chatRooms.has(roomId)) {
      this.chatRooms.set(roomId, new Set());
    }
    
    const room = this.chatRooms.get(roomId);
    room.add(ws);
    
    this.userSessions.set(ws, {
      userId,
      rooms: new Set([roomId])
    });
    
    ws.send(JSON.stringify({
      type: 'room_joined',
      roomId
    }));
  }

  removeUserFromRooms(ws, userId) {
    const session = this.userSessions.get(ws);
    if (!session) return;
    
    for (const roomId of session.rooms) {
      const room = this.chatRooms.get(roomId);
      if (room) {
        room.delete(ws);
        
        // Clean up empty rooms
        if (room.size === 0) {
          this.chatRooms.delete(roomId);
        }
      }
    }
    
    this.userSessions.delete(ws);
  }

  broadcastToRoom(roomId, message, excludeWs = null) {
    const room = this.chatRooms.get(roomId);
    if (!room) return;
    
    const messageStr = JSON.stringify(message);
    
    for (const client of room) {
      if (client !== excludeWs && client.readyState === 1) {
        client.send(messageStr);
      }
    }
  }
}

module.exports = TokenAccessManager;
