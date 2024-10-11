const express = require('express');
const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');
const axios = require('axios');
const PQueue = require('p-queue');
const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;

let client;
let qrCodeData = null;
let isClientReady = false;
let isInitializing = false;

const queue = new PQueue.default({ concurrency: 3 });

app.get('/', (_, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>WhatsApp Web Authentication</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 20px; }
                #qr-container { margin: 20px 0; }
                button { padding: 10px 20px; margin: 5px; }
            </style>
        </head>
        <body>
            <h1>WhatsApp Web Authentication</h1>
            <div id="status"></div>
            <div id="qr-container"></div>
            <button id="init-button" onclick="initializeWhatsApp()">Iniciar WhatsApp</button>
            <button id="close-button" onclick="closeWhatsApp()" style="display:none;">Cerrar WhatsApp</button>
            <script>
                function updateStatus(message) {
                    document.getElementById('status').innerHTML = '<h2>' + message + '</h2>';
                }

                function showQR(qrCode) {
                    document.getElementById('qr-container').innerHTML = '<img src="' + qrCode + '" alt="QR Code" />';
                }

                function initializeWhatsApp() {
                    fetch('/initialize')
                        .then(response => response.json())
                        .then(data => {
                            updateStatus(data.message);
                            if (data.qr) {
                                showQR(data.qr);
                            }
                        })
                        .catch(error => {
                            console.error('Error:', error);
                            updateStatus('Error al inicializar WhatsApp');
                        });
                }

                function closeWhatsApp() {
                    fetch('/close')
                        .then(response => response.json())
                        .then(data => {
                            updateStatus(data.message);
                            document.getElementById('qr-container').innerHTML = '';
                            document.getElementById('init-button').style.display = 'inline';
                            document.getElementById('close-button').style.display = 'none';
                        });
                }

                // Polling para actualizar el estado
                setInterval(() => {
                    fetch('/status')
                        .then(response => response.json())
                        .then(data => {
                            updateStatus(data.status);
                            if (data.isReady) {
                                document.getElementById('init-button').style.display = 'none';
                                document.getElementById('close-button').style.display = 'inline';
                            }
                        });
                }, 5000);
            </script>
        </body>
        </html>
    `);
});

async function initializeWhatsAppClient(retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`Intento de inicialización ${i + 1} de ${retries}`);
            console.log('Node version:', process.version);
            console.log('Puppeteer executable path:', process.env.PUPPETEER_EXECUTABLE_PATH);
            console.log('Chrome AWS Lambda path:', await chromium.executablePath);

            client = new Client({
                puppeteer: {
                    executablePath: await chromium.executablePath,
                    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
                    defaultViewport: chromium.defaultViewport,
                    headless: chromium.headless,
                },
                session: null
            });

            client.on('qr', async (qr) => {
                console.log('Código QR recibido');
                qrCodeData = await qrcode.toDataURL(qr);
            });

            client.on('ready', () => {
                console.log('Cliente WhatsApp listo');
                isClientReady = true;
                qrCodeData = null;
            });

            client.on('auth_failure', msg => {
                console.error('Autenticación fallida', msg);
            });

            client.on('disconnected', (reason) => {
                console.log('Cliente desconectado', reason);
                isClientReady = false;
            });

            await client.initialize();
            console.log('Cliente inicializado con éxito');
            return true;
        } catch (error) {
            console.error(`Error en el intento ${i + 1}:`, error);
            if (i === retries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 5000)); // Espera 5 segundos antes de reintentar
        }
    }
    return false;
}

app.get('/initialize', async (req, res) => {
    if (isInitializing || isClientReady) {
        await closeWhatsAppSession();
    }

    isInitializing = true;
    isClientReady = false;
    qrCodeData = null;

    try {
        const success = await initializeWhatsAppClient();
        if (success) {
            res.json({ message: 'Cliente de WhatsApp inicializado.', qr: qrCodeData });
        } else {
            res.status(500).json({ error: 'No se pudo inicializar el cliente después de múltiples intentos' });
        }
    } catch (error) {
        console.error('Error detallado de inicialización:', error);
        console.error('Stack trace:', error.stack);
        res.status(500).json({ 
            error: 'Error al inicializar el cliente de WhatsApp', 
            details: error.message,
            stack: error.stack
        });
    } finally {
        isInitializing = false;
    }
});

app.get('/close', async (req, res) => {
    await closeWhatsAppSession();
    res.json({ message: 'Sesión de WhatsApp cerrada.' });
});

app.get('/status', (req, res) => {
    res.json({
        status: isClientReady ? 'WhatsApp está listo' : 'WhatsApp no está iniciado',
        isReady: isClientReady
    });
});

async function closeWhatsAppSession() {
    if (client) {
        await client.destroy();
        client = null;
    }
    isClientReady = false;
    isInitializing = false;
    qrCodeData = null;
}

app.get('/send-message', async (req, res) => {
    const { phone, message } = req.query;

    if (!phone || !message) {
        return res.status(400).json({ error: 'Se requieren los parámetros phone y message' });
    }

    if (!isClientReady) {
        return res.status(503).json({ error: 'El cliente de WhatsApp aún no está listo.' });
    }

    try {
        await queue.add(async () => {
            const chatId = `${phone}@c.us`;
            await client.sendMessage(chatId, message);
        });
        res.json({ success: true, message: 'Mensaje enviado con éxito' });
    } catch (error) {
        console.error('Error al enviar mensaje:', error);
        res.status(500).json({ error: 'Error al enviar el mensaje' });
    }
});

app.get('/send-message_media', async (req, res) => {
    const { phone, message, fileUrl } = req.query;

    if (!phone || !message || !fileUrl) {
        return res.status(400).json({ error: 'Se requieren los parámetros phone, message y fileUrl' });
    }

    if (!isClientReady) {
        return res.status(503).json({ error: 'El cliente de WhatsApp aún no está listo.' });
    }

    try {
        await queue.add(async () => {
            const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
            const media = new MessageMedia(
                response.headers['content-type'],
                Buffer.from(response.data).toString('base64'),
                fileUrl.split('/').pop()
            );
            const chatId = `${phone}@c.us`;
            await client.sendMessage(chatId, message);
            await client.sendMessage(chatId, media);
        });
        res.json({ success: true, message: 'Mensaje y archivo multimedia enviados con éxito' });
    } catch (error) {
        console.error('Error al enviar mensaje multimedia:', error);
        res.status(500).json({ error: 'Error al enviar el mensaje multimedia' });
    }
});

app.get('/statusinstancias', (req, res) => {
    res.send(`
        <h1>Estado de la Instancia de WhatsApp</h1>
        <p>Estado: ${isClientReady ? 'Activa' : 'Inactiva'}</p>
        ${isClientReady ? '<button onclick="cerrarSesion()">Cerrar Sesión</button>' : ''}
        <script>
            function cerrarSesion() {
                fetch('/close')
                    .then(response => response.json())
                    .then(data => {
                        alert(data.message);
                        location.reload();
                    });
            }
        </script>
    `);
});

server.listen(port, () => {
    console.log(`Servidor escuchando en el puerto ${port}`);
});