#!/usr/bin/env python3
"""
PDF Generator - Converts briefing JSON to beautiful PDF
"""

import json
import sys
from pathlib import Path
from datetime import datetime
from typing import Dict, Any


class PDFGenerator:
    """Generates PDF reports from briefing data"""

    def __init__(self, base_dir: str = "/workspace/group/nanoclaw-skills/news-briefing"):
        self.base_dir = Path(base_dir)
        self.templates_dir = self.base_dir / "templates"
        self.reports_dir = self.base_dir / "reports"

    def load_template(self) -> str:
        """Load HTML template"""
        template_file = self.templates_dir / "briefing_template.html"
        with open(template_file, 'r') as f:
            return f.read()

    def load_briefing(self, briefing_file: str) -> Dict[str, Any]:
        """Load briefing JSON"""
        with open(briefing_file, 'r') as f:
            return json.load(f)

    def render_article(self, article: Dict[str, Any]) -> str:
        """Render a single article as HTML"""
        title = article.get("title", "Untitled")
        summary = article.get("summary", "")
        impact = article.get("impact", "")
        url = article.get("url", "")
        source = article.get("source", "Unknown")
        published = article.get("published", "")
        relevance = article.get("relevance_score", 5)

        html = f"""
    <div class="article">
        <div class="article-header">
            <div class="article-title">{self._escape_html(title)}</div>
            <div class="relevance-badge">{relevance}/10</div>
        </div>
        <div class="article-meta">
            <span>📰 {self._escape_html(source)}</span>
            <span>🕒 {self._escape_html(published)}</span>
        </div>
        <div class="article-summary">{self._escape_html(summary)}</div>
        """

        if impact:
            html += f"""
        <div class="article-impact">
            <strong>💡 Why it matters:</strong> {self._escape_html(impact)}
        </div>
            """

        if url:
            html += f"""
        <div>
            <a href="{self._escape_html(url)}" class="article-link" target="_blank">🔗 {self._escape_html(url)}</a>
        </div>
            """

        html += """
    </div>
        """

        return html

    def render_section(self, section: Dict[str, Any]) -> str:
        """Render a section with articles"""
        category = section.get("category", "unknown")
        category_title = section.get("category_title", "Unknown")
        article_count = section.get("article_count", 0)
        articles = section.get("articles", [])
        key_trends = section.get("key_trends", [])

        # Determine section class for color coding
        section_class = "world" if "world" in category else \
                       "tech" if "tech" in category else \
                       "finance" if "finance" in category or "economy" in category else \
                       "culture" if "culture" in category else \
                       "custom"

        html = f"""
    <div class="section">
        <div class="section-header {section_class}">
            <div class="section-title">{category_title}</div>
            <div class="section-subtitle">{article_count} articles</div>
        </div>
        """

        # Render articles
        for article in articles:
            html += self.render_article(article)

        # Render trends if available
        if key_trends:
            html += """
        <div class="trends-box">
            <div class="trends-title">🔍 Key Trends</div>
            <ul class="trends-list">
            """
            for trend in key_trends:
                html += f"<li>{self._escape_html(trend)}</li>\n"
            html += """
            </ul>
        </div>
            """

        html += """
    </div>
        """

        return html

    def render_briefing(self, briefing: Dict[str, Any], template: str) -> str:
        """Render complete briefing as HTML"""
        metadata = briefing.get("metadata", {})
        summary = briefing.get("summary", {})
        sections = briefing.get("sections", [])

        # Format date
        date = metadata.get("date", datetime.now().strftime("%Y-%m-%d"))
        generated_at = metadata.get("generated_at", datetime.now().isoformat())
        formatted_date = datetime.strptime(date, "%Y-%m-%d").strftime("%B %d, %Y")
        formatted_time = datetime.fromisoformat(generated_at).strftime("%B %d, %Y at %I:%M %p")

        # Render all sections
        sections_html = ""
        for section in sections:
            sections_html += self.render_section(section)

        # Replace template placeholders
        html = template.replace("{{date}}", formatted_date)
        html = html.replace("{{total_categories}}", str(summary.get("total_categories", 0)))
        html = html.replace("{{total_articles}}", str(summary.get("total_articles", 0)))
        html = html.replace("{{total_sources}}", str(len(summary.get("sources", []))))
        html = html.replace("{{generated_at}}", formatted_time)
        html = html.replace("{{sections}}", sections_html)

        return html

    def save_html(self, html: str, output_file: str) -> str:
        """Save HTML to file"""
        with open(output_file, 'w') as f:
            f.write(html)
        return output_file

    def _escape_html(self, text: str) -> str:
        """Escape HTML special characters"""
        if not isinstance(text, str):
            text = str(text)
        text = text.replace("&", "&amp;")
        text = text.replace("<", "&lt;")
        text = text.replace(">", "&gt;")
        text = text.replace('"', "&quot;")
        text = text.replace("'", "&#39;")
        return text


def main():
    """Main entry point"""
    generator = PDFGenerator()

    print("📄 PDF Generator - News Briefing System")
    print("=" * 60)

    # Find latest briefing
    briefing_files = sorted(generator.reports_dir.glob("briefing_*.json"), reverse=True)
    if not briefing_files:
        print("❌ No briefing files found!")
        return

    briefing_file = briefing_files[0]
    print(f"\n📥 Loading briefing: {briefing_file.name}")

    # Load briefing and template
    briefing = generator.load_briefing(str(briefing_file))
    template = generator.load_template()

    print(f"\n🎨 Rendering HTML...")
    html = generator.render_briefing(briefing, template)

    # Save HTML
    date = briefing.get("metadata", {}).get("date", datetime.now().strftime("%Y-%m-%d"))
    html_file = generator.reports_dir / f"briefing_{date}.html"
    generator.save_html(html, str(html_file))
    print(f"   ✓ HTML saved: {html_file.name}")

    # PDF output path
    pdf_file = generator.reports_dir / f"briefing_{date}.pdf"

    print(f"\n✅ HTML generation complete!")
    print(f"   HTML: {html_file}")
    print(f"   Next: Convert to PDF using agent-browser")
    print(f"   PDF will be: {pdf_file}")

    # Return paths for next step
    return str(html_file), str(pdf_file)


if __name__ == "__main__":
    main()
