const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const chatRoutes = require('./routes/chat.routes');
const messageRoutes = require('./routes/message.routes');

const app = express();
const path = require('path');
const uploadRoutes = require('./routes/upload.routes');

app.use(express.static(path.join(__dirname, '../public')));
app.use(cors());
app.use(express.json());
app.use('/api/upload', uploadRoutes);
app.use('/uploads', express.static('uploads'));

// роуты
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/messages', messageRoutes);
// тест
app.get('/', (req, res) => {
  res.send('API working');
});

module.exports = app;
