const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const mysql = require('mysql2');
const axios = require('axios');
const FormData = require('form-data');
const session = require('express-session');
const pdfParse = require('pdf-parse');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');

const app = express();
const port = 3000;

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Parse JSON bodies
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true
}));

// MySQL setup
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'Revanth1216',
  database: 'test'
});

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Email transporter setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'your-email@gmail.com', // Replace with your email
    pass: 'your-app-specific-password' // Replace with your app-specific password
  }
});

// Routes (Job Seekers)
app.get('/', (req, res) => {
  res.redirect('/login');
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.post('/register', (req, res) => {
  const { fname, lname, email, password } = req.body;
  db.query(
    'INSERT INTO registration (fname, lname, email, password) VALUES (?, ?, ?, ?)',
    [fname, lname, email, password],
    (err) => {
      if (err) return res.status(500).send('Registration failed');
      res.redirect('/login');
    }
  );
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  db.query(
    'SELECT * FROM registration WHERE email = ? AND password = ?',
    [email, password],
    (err, results) => {
      if (err) return res.status(500).send('Login failed');
      if (results.length > 0) {
        req.session.user = results[0];
        res.redirect('/home');
      } else {
        res.status(401).send('Invalid credentials');
      }
    }
  );
});

app.get('/home', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.post('/upload-resume', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const pdfBuffer = fs.readFileSync(filePath);
    const parsed = await pdfParse(pdfBuffer);
    const resumeText = parsed.text;

    const prompt = `
Extract the following information from this resume in JSON format. 
Only include fields that are clearly present in the resume.
Be concise and accurate.

{
  "name": "Full name (first and last)",
  "email": "Email address if found",
  "phone": "Phone number if found",
  "gender": "Only if explicitly mentioned",
  "skills": ["List of technical/professional skills"],
  "experience": [
    {
      "position": "Job title",
      "company": "Company name",
      "duration": "Employment period",
      "description": "Brief description of responsibilities"
    }
  ],
  "education": [
    {
      "degree": "Degree/certification name",
      "institution": "School/university name",
      "year": "Completion year"
    }
  ]
}

Resume Text:
"""${resumeText}"""
`;

    const apiResponse = await callGeminiAPI(prompt);
    const textOutput = apiResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    let parsedData = {
      name: null,
      email: null,
      phone: null,
      gender: null,
      skills: [],
      experience: [],
      education: []
    };

    try {
      const jsonStart = textOutput.indexOf('{');
      const jsonEnd = textOutput.lastIndexOf('}') + 1;
      const jsonString = textOutput.slice(jsonStart, jsonEnd);
      parsedData = JSON.parse(jsonString);
    } catch (e) {
      console.error('Failed to parse JSON response, using fallback extraction:', e);
      parsedData.name = extractName(resumeText);
      parsedData.email = extractEmail(resumeText);
      parsedData.phone = extractPhone(resumeText);
      parsedData.skills = extractSkills(resumeText);
      parsedData.experience = extractExperience(resumeText);
      parsedData.education = extractEducation(resumeText);
    }

    const dbData = {
      name: parsedData.name || 'Not Provided',
      email: parsedData.email || 'Not Provided',
      phone: parsedData.phone || 'Not Provided',
      gender: parsedData.gender || 'Not Provided',
      skills: parsedData.skills?.length > 0 ? parsedData.skills.join(', ') : 'Not Provided',
      experience: parsedData.experience?.length > 0
        ? parsedData.experience.map(exp => `${exp.position || 'Position'} at ${exp.company || 'Company'} (${exp.duration || 'Duration'})`).join('; ')
        : 'Not Provided',
      education: parsedData.education?.length > 0
        ? parsedData.education.map(edu => `${edu.degree || 'Degree'} from ${edu.institution || 'Institution'} (${edu.year || 'Year'})`).join('; ')
        : 'Not Provided'
    };

    db.query(
      'INSERT INTO seekers (name, email, phone, gender, skills, experience, education) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [dbData.name, dbData.email, dbData.phone, dbData.gender, dbData.skills, dbData.experience, dbData.education],
      (err) => {
        if (err) {
          console.error('Database insertion error:', err);
          return res.status(500).json({ success: false, message: 'Database insert failed' });
        }
        res.json({ success: true, message: 'Resume processed successfully!' });
      }
    );
  } catch (error) {
    console.error('Resume processing error:', error);
    res.status(500).json({ success: false, message: 'Resume processing failed' });
  }
});

// Helper function to call Gemini API with retries
async function callGeminiAPI(prompt, retries = 3, delay = 2000) {
  try {
    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1/models/gemini-1.5-pro:generateContent',
      {
        contents: [{ parts: [{ text: prompt }] }]
      },
      {
        params: { key: 'AIzaSyAZCf4D7ypb7HK6C-1H16yWZ1jd1FOZ6Xg' },
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );
    return response.data;
  } catch (error) {
    console.error(`API call failed: ${error.message}`);
    
    if (retries > 0 && error.response?.status === 429) {
      console.log(`Rate limit hit. Retrying in ${delay}ms... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return callGeminiAPI(prompt, retries - 1, Math.min(delay * 2, 10000)); // Cap delay at 10 seconds
    }
    
    return {
      candidates: [{
        content: {
          parts: [{
            text: 'Unable to process due to API rate limits or errors.'
          }]
        }
      }]
    };
  }
}

// Helper functions for fallback extraction
function extractName(text) {
  const nameMatch = text.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/m);
  return nameMatch ? nameMatch[0].trim() : null;
}

function extractEmail(text) {
  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
  return emailMatch ? emailMatch[0] : null;
}

function extractPhone(text) {
  const phoneMatch = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  return phoneMatch ? phoneMatch[0] : null;
}

function extractSkills(text) {
  const skillsSection = text.match(/SKILLS?[\s:]+([\s\S]+?)(?=\n\n|\n[A-Z]{3,}|$)/i);
  if (!skillsSection) return [];
  
  const skillsText = skillsSection[1];
  return skillsText.split(/[,•\n]/)
    .map(skill => skill.trim())
    .filter(skill => skill.length > 0);
}

function extractExperience(text) {
  const expSection = text.match(/EXPERIENCE[\s:]+([\s\S]+?)(?=\n\n[A-Z]{3,}|$)/i);
  if (!expSection) return [];
  
  const expText = expSection[1];
  const jobs = expText.split(/\n(?=\w)/);
  return jobs.map(job => {
    const lines = job.split('\n').filter(line => line.trim().length > 0);
    if (lines.length < 2) return null;
    
    return {
      position: lines[0].trim(),
      company: lines[1].trim(),
      duration: lines.find(line => line.match(/\d{4}/)) || 'Unknown',
      description: lines.slice(2).join(' ').trim()
    };
  }).filter(job => job !== null);
}

function extractEducation(text) {
  const eduSection = text.match(/EDUCATION[\s:]+([\s\S]+?)(?=\n\n[A-Z]{3,}|$)/i);
  if (!eduSection) return [];
  
  const eduText = eduSection[1];
  const entries = eduText.split(/\n(?=\w)/);
  return entries.map(entry => {
    const lines = entry.split('\n').filter(line => line.trim().length > 0);
    if (lines.length < 2) return null;
    
    return {
      degree: lines[0].trim(),
      institution: lines[1].trim(),
      year: lines.find(line => line.match(/\d{4}/)) || 'Unknown'
    };
  }).filter(entry => entry !== null);
}

// Routes (Recruiters)
app.get('/recruiter-register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'recruiter-register.html'));
});

app.post('/recruiter-register', async (req, res) => {
  const { name, email, password, company } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.query(
      'INSERT INTO hiring_reg (name, email, password, company) VALUES (?, ?, ?, ?)',
      [name, email, hashedPassword, company],
      (err) => {
        if (err) return res.status(500).send('Registration failed');
        res.redirect('/recruiter-login');
      }
    );
  } catch (error) {
    res.status(500).send('Error hashing password');
  }
});

app.get('/recruiter-login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'recruiter-login.html'));
});

app.post('/recruiter-login', async (req, res) => {
  const { email, password } = req.body;

  db.query(
    'SELECT * FROM hiring_reg WHERE email = ?',
    [email],
    async (err, results) => {
      if (err) return res.status(500).send('Login failed');
      if (results.length > 0) {
        const match = await bcrypt.compare(password, results[0].password);
        if (match) {
          req.session.recruiter = results[0];
          res.redirect('/recruiter-home');
        } else {
          res.status(401).send('Invalid credentials');
        }
      } else {
        res.status(401).send('Invalid credentials');
      }
    }
  );
});

app.get('/recruiter-home', (req, res) => {
  if (!req.session.recruiter) return res.redirect('/recruiter-login');
  res.sendFile(path.join(__dirname, 'public', 'recruiter-home.html'));
});

app.post('/search-candidates', async (req, res) => {
  console.log('Session:', req.session.recruiter);
  if (!req.session.recruiter) return res.status(401).json({ success: false, message: 'Not logged in' });

  const { jobDescription } = req.body;
  console.log('Received job description:', jobDescription);

  if (!jobDescription) {
    return res.status(400).json({ success: false, message: 'Job description is required' });
  }

  try {
    // Try LLM-based search
    const prompt = `
      Extract key requirements from this job description and suggest matching candidate criteria from a database. Return in JSON format.

      Job Description: """${jobDescription}"""

      Output format:
      {
        "requirements": ["skill1", "skill2", ...],
        "candidate_criteria": { "skills": ["required skills"], "experience": "minimum years" }
      }
    `;

    console.log('Sending prompt to Gemini API');
    const apiResponse = await callGeminiAPI(prompt);
    const textOutput = apiResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('Gemini API response:', textOutput);

    let parsedCriteria = { requirements: [], candidate_criteria: { skills: [] } };

    if (textOutput && textOutput !== 'Unable to process due to API rate limits or errors.') {
      try {
        const jsonStart = textOutput.indexOf('{');
        const jsonEnd = textOutput.lastIndexOf('}') + 1;
        if (jsonStart !== -1 && jsonEnd !== -1) {
          const jsonString = textOutput.slice(jsonStart, jsonEnd);
          parsedCriteria = JSON.parse(jsonString);
        } else {
          console.warn('No valid JSON found in API response');
        }
      } catch (e) {
        console.error('Failed to parse LLM response:', e);
      }
    }

    console.log('Parsed criteria:', parsedCriteria);

    // Fallback to keyword-based search if LLM fails or returns no skills
    let skills = parsedCriteria.candidate_criteria.skills || [];
    if (skills.length === 0) {
      console.log('Falling back to keyword-based search');
      skills = jobDescription.split(/[,;\s]+/).map(skill => skill.trim()).filter(skill => skill.length > 0);
    }

    // Build SQL query with strict matching (all skills required)
    let query = 'SELECT * FROM seekers WHERE 1=1';
    const params = [];

    if (skills.length > 0) {
      skills.forEach(skill => {
        query += ' AND skills LIKE ?';
        params.push(`%${skill}%`);
      });
    }

    console.log('SQL Query:', query, 'Params:', params);
    db.query(query, params, (err, results) => {
      if (err) {
        console.error('Database query error:', err);
        return res.status(500).json({ success: false, message: 'Database error' });
      }

      console.log('Query results:', results);
      const candidates = results.map(candidate => ({
        id: candidate.id,
        name: candidate.name,
        skills: candidate.skills
      }));

      res.json({ success: true, candidates });
    });
  } catch (error) {
    console.error('Error processing job description:', error);
    res.status(500).json({ success: false, message: 'Error processing job description' });
  }
});

app.post('/shortlist', (req, res) => {
  if (!req.session.recruiter) return res.status(401).json({ success: false, message: 'Not logged in' });

  const { candidateId } = req.body;
  const recruiterId = req.session.recruiter.id;

  db.query(
    'INSERT INTO shortlist (recruiter_id, candidate_id) VALUES (?, ?)',
    [recruiterId, candidateId],
    (err) => {
      if (err) return res.status(500).json({ success: false, message: 'Failed to shortlist' });
      res.json({ success: true, message: 'Candidate shortlisted!' });
    }
  );
});

app.post('/schedule-interview', (req, res) => {
  if (!req.session.recruiter) return res.status(401).json({ success: false, message: 'Not logged in' });

  const { candidateId } = req.body;
  const recruiterId = req.session.recruiter.id;

  db.query(
    'SELECT email FROM seekers WHERE id = ?',
    [candidateId],
    (err, results) => {
      if (err || results.length === 0) return res.status(500).json({ success: false, message: 'Candidate not found' });

      const candidateEmail = results[0].email;

      const mailOptions = {
        from: 'your-email@gmail.com',
        to: candidateEmail,
        subject: 'Interview Opportunity',
        text: `Dear Candidate, ${req.session.recruiter.name} from ${req.session.recruiter.company} is interested in interviewing you. Please reply to schedule a time.`
      };

      transporter.sendMail(mailOptions, (error, info) => {
        if (error) return res.status(500).json({ success: false, message: 'Failed to send email' });

        db.query(
          'INSERT INTO interview (recruiter_id, candidate_id, status, email_sent_at) VALUES (?, ?, ?, NOW())',
          [recruiterId, candidateId, 'contacted'],
          (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Failed to schedule interview' });
            res.json({ success: true, message: 'Interview scheduled and email sent!' });
          }
        );
      });
    }
  );
});

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});