import markdown
from xhtml2pdf import pisa
import sys

def convert_md_to_pdf(md_file, pdf_file):
    with open(md_file, 'r', encoding='utf-8') as f:
        text = f.read()
    
    # Convert Markdown to HTML
    html_content = markdown.markdown(text)
    
    # Add some CSS for better PDF rendering
    html = f"""
    <html>
    <head>
    <style>
        @page {{
            size: a4 portrait;
            margin: 2cm;
        }}
        body {{ 
            font-family: Helvetica, Arial, sans-serif; 
            font-size: 12pt; 
            line-height: 1.5; 
            color: #333;
        }}
        h1 {{ 
            color: #2c3e50; 
            text-align: center;
            font-size: 24pt;
            margin-bottom: 20px;
        }}
        h2 {{ 
            color: #34495e; 
            border-bottom: 1px solid #bdc3c7; 
            padding-bottom: 5px; 
            margin-top: 20px;
            font-size: 16pt;
        }}
        strong {{
            color: #2980b9;
        }}
        ul {{ 
            margin-bottom: 15px; 
        }}
        li {{ 
            margin-bottom: 8px; 
        }}
    </style>
    </head>
    <body>
    {html_content}
    </body>
    </html>
    """
    
    with open(pdf_file, "w+b") as result_file:
        pisa_status = pisa.CreatePDF(html, dest=result_file)
        
    if pisa_status.err:
        print(f"Error generating PDF: {pisa_status.err}")
        sys.exit(1)
    else:
        print(f"PDF generated successfully at {pdf_file}")

if __name__ == "__main__":
    convert_md_to_pdf('docs/Draftly_One_Pager.md', 'docs/Draftly_One_Pager.pdf')
