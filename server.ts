import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { CATEGORIES } from './src/constants.ts';

dotenv.config();

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json({ limit: '50mb' }));

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/classify', async (req, res) => {
  try {
    const { base64Image, mimeType } = req.body;
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("يرجى التأكد من إضافة مفتاح GEMINI_API_KEY في إعدادات المنصة (Secrets) لكي تعمل خاصية الفرز الذكي.");
    }
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
    const categoriesList = CATEGORIES.map(c => `
      الفئة ${c.id}: ${c.name}
      البنود الفرعية: [${c.subCategories.join('، ')}]
    `).join('\n');
    
    const prompt = `
      أنت خبير في الإشراف التربوي وتقييم أداء المعلمين في المدارس. مهمتك هي تحليل المرفق (قد يكون صورة لصف دراسي، تحضير، ورقة عمل، شهادة حضور دورة، لقطة شاشة من منصة مدرستي، أو ملف PDF) وتصنيفه بدقة وحرفية.
      
      الهيكل التنظيمي للفرز:
      ${categoriesList}
      
      المطلوب منك هو:
      1. قراءة محتويات المرفق بدقة والتعرف على ماهيته.
      2. تحديد جميع الفئات والبنود الفرعية المناسبة للمحتوى (استخرج الأنسب).
      3. استخراج "اسم البند الفرعي" بالضبط كما هو مكتوب في القائمة أعلاه (تطابق حرفي تماماً). لا تخترع أسماء جديدة أو خارج القائمة المحددة لكل فئة.
      4. اقتراح عنوان مناسب ووصف قصير للمرفق ليكون اسماً لملفه (بدون مسافات، مثال: شهادة_دورة_التعلم_النشط).
      
      يجب أن يكون ردك بصيغة JSON فقط كالتالي:
      {
        "classifications": [
          { "categoryId": رقم_الفئة, "subCategoryName": "اسم_البند_الفرعي_حرفياً" }
        ],
        "suggestedTitle": "عنوان_مقترح_للملف"
      }
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: mimeType || "image/jpeg",
                data: base64Image.split(',')[1] || base64Image
              }
            }
          ]
        }
      ],
      config: {
        temperature: 0.1,
        responseMimeType: "application/json"
      }
    });

    let text = response.text || "{}";
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(text);
    
    const classifications = [];
    if (result.classifications && Array.isArray(result.classifications)) {
      for (const r of result.classifications) {
        const category = CATEGORIES.find(c => c.id === Number(r.categoryId));
        if (category) {
          const validSub = category.subCategories.find(sub => sub === r.subCategoryName);
          if (validSub) {
            classifications.push({ categoryId: category.id, subCategoryName: validSub });
          } else {
            // Strict fallback: If the model hallucinates a subcategory, we put it in the first available subcategory
            classifications.push({ categoryId: category.id, subCategoryName: category.subCategories[0] });
          }
        }
      }
    }

    res.json({
      classifications: classifications.length > 0 ? classifications : [{ categoryId: CATEGORIES[0].id, subCategoryName: CATEGORIES[0].subCategories[0] }],
      suggestedTitle: result.suggestedTitle || "مرفق_غير_معنون"
    });
  } catch (error: any) {
    console.error("Classification error:", error);
    res.status(500).json({ error: 'Failed to classify image', details: error.message });
  }
});

app.get('/api/auth/dropbox/url', (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const redirectUri = `${protocol}://${host}/api/auth/dropbox/callback`;

  const params = new URLSearchParams({
    client_id: process.env.DROPBOX_CLIENT_ID || '',
    redirect_uri: redirectUri,
    response_type: 'code',
  });

  const authUrl = `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
  res.json({ url: authUrl });
});

app.get('/api/auth/dropbox/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_ERROR', error: '${error_description}' }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication failed: ${error_description}. This window should close automatically.</p>
        </body>
      </html>
    `);
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const redirectUri = `${protocol}://${host}/api/auth/dropbox/callback`;

  try {
    const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${process.env.DROPBOX_CLIENT_ID}:${process.env.DROPBOX_CLIENT_SECRET}`).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: redirectUri
      })
    });

    const tokenData = await tokenRes.json();
    
    if (tokenData.error) {
      throw new Error(tokenData.error_description || tokenData.error);
    }
    
    const accessToken = tokenData.access_token;
    
    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', provider: 'dropbox', token: '${accessToken}' }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication successful. This window should close automatically.</p>
        </body>
      </html>
    `);
  } catch (err: any) {
    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_ERROR', error: '${err.message}' }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication failed. This window should close automatically.</p>
        </body>
      </html>
    `);
  }
});

// Vite middleware for dev or static serving for production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();
