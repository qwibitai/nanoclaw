# ⚡ Quick Start - AI News Briefing System

**Get started in 2 minutes!**

---

## 🎯 What This Does

Every day at 7 AM, you'll get a WhatsApp PDF with:
- 📰 Top news across 4 categories
- 🔗 Source links for every article
- 📊 Relevance scores (1-10)
- 🔍 Key trends identified

---

## 🚀 Immediate Actions

### 1. Check Your First Briefing

**Look in WhatsApp** - You should have received:
`briefing_2026-03-09.pdf` (196 KB)

If not, generate manually:
```bash
cd /workspace/group/news-briefing-poc
python3 main.py
```

### 2. Customize Your Topics (Optional)

```bash
# See what you're tracking
python3 topic_manager.py list

# Add something you care about
python3 topic_manager.py add custom_tracking "SpaceX launches"

# Remove something you don't care about
python3 topic_manager.py remove "North Dakota state banking system"
```

### 3. That's It!

The system will automatically:
- ✅ Research news every day at 7 AM
- ✅ Compile into a professional PDF
- ✅ Deliver to WhatsApp
- ✅ Track what you've seen (no duplicates)

---

## 📱 Daily Usage

### Morning Routine

1. Wake up
2. Check WhatsApp
3. Open briefing PDF
4. Skim headlines (2 min)
5. Read interesting articles (5 min)
6. Click source links for details

**Total: 7-10 minutes to stay fully informed** 🎯

---

## 🎨 Common Customizations

### Change Delivery Time

```bash
# 8:00 AM instead of 7:00 AM
python3 topic_manager.py set-time 08:00

# 6:30 AM
python3 topic_manager.py set-time 06:30
```

### Add Personal Topics

```bash
# Track your company
python3 topic_manager.py add custom_tracking "YourCompany Inc"

# Track competitors
python3 topic_manager.py add custom_tracking "Competitor XYZ"

# Track investments
python3 topic_manager.py add economy_finance "Tesla stock"
```

### Disable Categories You Don't Want

```bash
# Don't need finance news?
python3 topic_manager.py disable economy_finance

# Re-enable later
python3 topic_manager.py enable economy_finance
```

---

## 🐛 Troubleshooting

### PDF didn't arrive

```bash
# Generate manually
python3 main.py

# Check reports folder
ls reports/briefing_*.pdf
```

### Too many articles

```bash
# Disable a category
python3 topic_manager.py disable economy_finance

# Or remove specific topics
python3 topic_manager.py remove "topic name"
```

### Want more articles

```bash
# Add more topics
python3 topic_manager.py add technology "quantum computing"
```

---

## 📚 Learn More

- **Technical details**: Read `README.md`
- **Full user guide**: Read `USER_GUIDE.md`
- **Project summary**: Read `NEWS_BRIEFING_POC_SUMMARY.md`

---

## 💡 Pro Tips

1. **Start with defaults** - Use for a week before customizing
2. **Focus on specific topics** - "Claude AI" not just "AI"
3. **Trust relevance scores** - Read 8-10 first, 5-7 if time allows
4. **Review weekly** - Update topics based on what you actually read
5. **Share interesting articles** - Forward to colleagues/friends

---

## 🎉 You're Done!

The system is running. Just check WhatsApp every morning for your personalized news briefing.

**Enjoy staying informed without the noise!** 📰✨

---

*Questions? Check USER_GUIDE.md or README.md for details*
