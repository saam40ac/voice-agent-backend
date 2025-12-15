const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Endpoint API per Claude
app.post('/api/chat', async (req, res) => {
    try {
        const { messages, system } = req.body;

        // Validazione input
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ 
                error: 'Messages array is required' 
            });
        }

        // Chiamata API Anthropic
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-20250514',
                max_tokens: 1000,
                system: system || 'Sei un assistente vocale amichevole e disponibile.',
                messages: messages
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('Anthropic API Error:', errorData);
            return res.status(response.status).json({
                error: errorData.error?.message || 'API request failed'
            });
        }

        const data = await response.json();
        res.json(data);

    } catch (error) {
        console.error('Server Error:', error);
        res.status(500).json({ 
            error: 'Internal server error',
            message: error.message 
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Voice Agent API is running',
        timestamp: new Date().toISOString()
    });
});

// Avvio server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📡 API endpoint: http://localhost:${PORT}/api/chat`);
    console.log(`🏥 Health check: http://localhost:${PORT}/api/health`);
});
