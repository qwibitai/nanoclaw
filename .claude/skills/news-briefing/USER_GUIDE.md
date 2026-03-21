# 📖 User Guide - AI News Briefing System

**Quick reference for daily use**

---

## 🚀 Getting Started

### What You Get

Every day at 7:00 AM, you'll receive a WhatsApp PDF with:
- 📰 Top news across 4 categories
- 🌍 World highlights
- 💻 Technology updates
- 💰 Economy & finance
- 🔍 Your custom topics
- 🔗 Source links for every article
- 📊 Relevance scores and key trends

---

## 📱 Daily Use

### Check Your Briefing

1. **Receive**: PDF arrives in WhatsApp at 7:00 AM
2. **Open**: Tap to open the PDF
3. **Read**: Scroll through categorized news
4. **Click**: Tap source links to read full articles
5. **Done**: Stay informed in 5-10 minutes!

### Sample Briefing Caption

```
📰 Your Daily News Briefing
March 9, 2026

📊 Today's Brief:
• 4 categories covered
• 20 top articles
• 18 credible sources

🔥 Top Headlines:
1. Iran's Leadership Succession Following...
2. OpenAI Raises $110B in Historic Funding...
3. Oil Prices Surge Past $100 on Middle East...
```

---

## 🎯 Managing Topics

### View Current Topics

```bash
python3 topic_manager.py list
```

### Add a New Topic

```bash
# Add to custom tracking
python3 topic_manager.py add custom_tracking "SpaceX launches"

# Add to technology
python3 topic_manager.py add technology "quantum computing breakthroughs"

# Add to world highlights
python3 topic_manager.py add world_highlights "climate change policy"
```

### Remove a Topic

```bash
python3 topic_manager.py remove "North Dakota state banking system"
```

### Example Topics You Might Add

**Technology:**
- DeepMind and Google AI developments
- Tesla and electric vehicle news
- Quantum computing breakthroughs
- Robotics and automation

**Finance:**
- Real estate market trends
- Venture capital funding rounds
- ESG investing developments
- Inflation and interest rate changes

**Custom:**
- Your company name
- Competitors in your industry
- Personal interests (sports teams, hobbies, etc.)
- Local news from your city

---

## ⏰ Changing Delivery Time

### Set a New Time

```bash
# 8:00 AM
python3 topic_manager.py set-time 08:00

# 6:30 AM
python3 topic_manager.py set-time 06:30

# 9:00 PM (21:00)
python3 topic_manager.py set-time 21:00
```

**Note**: Time is in 24-hour format and your local timezone.

---

## 🎨 Customizing Categories

### Disable a Category

Don't need economy news? Disable it:

```bash
python3 topic_manager.py disable economy_finance
```

### Enable a Category

```bash
python3 topic_manager.py enable economy_finance
```

---

## 📊 Understanding Your Briefing

### Relevance Scores

Each article has a **relevance score (1-10)**:
- **9-10**: Extremely important, must-read
- **7-8**: Significant, worth your time
- **5-6**: Interesting, optional
- **1-4**: Low priority

### Key Trends Section

At the end of each category, you'll see **Key Trends**:
- Patterns identified across multiple articles
- Emerging themes in that category
- What's gaining momentum

Example:
```
🔍 Key Trends:
▸ Historic capital influx into AI infrastructure
▸ Convergence of AI with specialized hardware
▸ Enterprise agentic AI deployment acceleration
```

### Article Structure

Each article includes:
- **Title**: Clear headline
- **Relevance Badge**: 1-10 score
- **Source**: Publication name (NBC News, Bloomberg, etc.)
- **Timestamp**: When published
- **Summary**: 2-3 sentence overview
- **Impact**: Why this matters to you
- **Link**: Full article URL

---

## 🔄 How Often to Update Topics

### When to Add Topics

- ✅ New interest or hobby develops
- ✅ Following a new company or technology
- ✅ Industry trends you want to track
- ✅ Personal or professional goals change

### When to Remove Topics

- ✅ No longer relevant to you
- ✅ Getting too much content on that topic
- ✅ Interest has shifted elsewhere

### Recommended Review

- **Weekly**: Skim topics to see if any need adjustment
- **Monthly**: Deep review of all categories
- **Quarterly**: Major topic overhaul if needed

---

## 💡 Pro Tips

### 1. Start Specific

Instead of:
- ❌ "artificial intelligence"

Use:
- ✅ "Claude AI and Anthropic developments"
- ✅ "OpenAI GPT model updates"
- ✅ "Google Gemini AI releases"

### 2. Focus on What Matters

Don't track everything! Keep it to:
- 3-5 world topics
- 3-5 tech topics
- 3-5 finance topics
- 3-5 custom topics

**Total sweet spot: 12-20 topics**

### 3. Use Custom Tracking Wisely

This is your personal category. Use it for:
- Your employer/company
- Direct competitors
- Personal investments
- Niche interests
- Local news that matters

### 4. Trust the Relevance Scores

Focus on **7-10 scores** when time is limited.
Read **5-6 scores** when you have more time.

### 5. Click Through to Sources

The summary is great, but for important news:
- Click the source link
- Read the full article
- Get complete context

---

## 🐛 Common Issues

### "No new articles today"

**Reason**: All articles were duplicates (already covered yesterday)

**What it means**: You're fully up to date! 🎉

**What to do**: Nothing! Memory resets after ~30 days.

---

### PDF didn't arrive

**Check**:
1. Is it past 7:00 AM? (or your custom delivery time)
2. Check WhatsApp connection
3. Look in reports folder: `reports/briefing_YYYY-MM-DD.pdf`

**Manual delivery**:
```bash
python3 main.py
```

---

### Too many articles

**Solution**:
```bash
# Disable a category
python3 topic_manager.py disable economy_finance

# OR reduce topics in a category
python3 topic_manager.py remove "topic name"
```

---

### Not enough articles

**Solution**:
```bash
# Add more topics
python3 topic_manager.py add technology "New topic here"

# Enable a disabled category
python3 topic_manager.py enable economy_finance
```

---

## 📞 Quick Commands Reference

```bash
# View all topics
python3 topic_manager.py list

# Add topic
python3 topic_manager.py add <category> "<topic text>"

# Remove topic
python3 topic_manager.py remove "<topic text>"

# Change time
python3 topic_manager.py set-time HH:MM

# Enable/disable category
python3 topic_manager.py enable <category>
python3 topic_manager.py disable <category>

# Manual briefing
python3 main.py
```

---

## 🎯 Workflow Examples

### Morning Routine

1. Wake up ☀️
2. Check WhatsApp
3. Open today's briefing PDF
4. Skim headlines (2 minutes)
5. Read high-relevance articles (3-5 minutes)
6. Click through for 1-2 deep dives (5 minutes)
7. **Total: 10-12 minutes to stay informed**

### Weekly Topic Review

1. Friday afternoon: Review the week's briefings
2. Note which topics were most valuable
3. Note which topics felt irrelevant
4. Update topics:
   ```bash
   python3 topic_manager.py add custom_tracking "New trend"
   python3 topic_manager.py remove "Old topic"
   ```

### Sharing with Team

1. Receive briefing
2. Screenshot interesting articles
3. Share in team chat
4. Or forward PDF: "Check today's tech section"

---

## 🚀 Advanced Usage

### Multiple Briefings Per Day

Want morning AND evening briefings?

Currently scheduled for 7:00 AM. You can:
- Manually run afternoon briefing: `python3 main.py`
- OR schedule second task for 6:00 PM

### Topic Organization

Organize by theme:
- **Career**: Industry news, competitors, professional development
- **Finance**: Stocks you own, market trends, investment opportunities
- **Personal**: Hobbies, interests, local community
- **Research**: Specific projects or learning goals

### Archiving

PDFs are saved in `reports/` folder:
```
reports/
├── briefing_2026-03-09.pdf
├── briefing_2026-03-08.pdf
├── briefing_2026-03-07.pdf
└── ...
```

Keep for reference, trends analysis, or personal archive.

---

## ✨ Best Practices

1. **Start Broad, Then Narrow**
   - Week 1: Keep all default topics
   - Week 2: Remove what you didn't read
   - Week 3: Add specific interests
   - Week 4: Fine-tune relevance

2. **Quality Over Quantity**
   - Better to have 15 great topics than 50 mediocre ones
   - Focus on actionable news

3. **Regular Maintenance**
   - Set calendar reminder: "Review news topics" (monthly)
   - Keep topics fresh and relevant

4. **Use as a Filter**
   - Let the AI do the heavy lifting
   - You just read the curated results
   - Save hours of scrolling Twitter/Reddit

5. **Share and Discuss**
   - Forward interesting articles to colleagues
   - Use as conversation starters
   - Build a more informed network

---

**Need help?** Check the main README.md for technical details.

**Enjoying the system?** Consider what additional topics would make it even more valuable!

---

*Last updated: March 9, 2026*
