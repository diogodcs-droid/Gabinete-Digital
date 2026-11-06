import { Document, Packer, Paragraph, TextRun, AlignmentType } from 'docx';
import { saveAs } from 'file-saver';
import { getAccessToken } from '@/src/lib/firebase';

async function uploadToGoogleDrive(blob: Blob, filename: string, accessToken: string) {
  try {
    const FOLDER_NAME = "Giliani Assistente - Sentenças do Gabinete Digital";
    let folderId = null;

    // 1. Search for the folder
    const searchResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.folder' and name='${FOLDER_NAME}' and trashed=false&spaces=drive`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (searchResponse.ok) {
      const searchData = await searchResponse.json();
      if (searchData.files && searchData.files.length > 0) {
        folderId = searchData.files[0].id;
      }
    }

    // 2. Create the folder if it doesn't exist
    if (!folderId) {
      const createFolderResponse = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: FOLDER_NAME,
          mimeType: 'application/vnd.google-apps.folder',
        }),
      });

      if (createFolderResponse.ok) {
        const createFolderData = await createFolderResponse.json();
        folderId = createFolderData.id;
      } else {
        throw new Error('Failed to create folder in Google Drive');
      }
    }

    // 3. Upload the file to the folder using multipart upload
    const metadata = {
      name: filename,
      parents: [folderId],
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);

    const uploadResponse = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: form,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Failed to upload to Google Drive: ${errorText}`);
    }
    
    console.log(`Document successfully uploaded to Google Drive folder: ${FOLDER_NAME}`);
  } catch (error) {
    console.error("Error uploading to Google Drive", error);
  }
}

export async function exportToDocx(text: string, filename: string = "Minuta_Sentenca.docx") {
  // Simple markdown to DOCX converter
  // Filter out final follow-up / prompt questions at the end of the text
  let cleanText = text.trim();
  const nadaMaisIndex = cleanText.lastIndexOf("Nada mais.");
  if (nadaMaisIndex !== -1) {
    // Cut off everything after "Nada mais.", but keep "Nada mais."
    cleanText = cleanText.substring(0, nadaMaisIndex + 10).trim();
  } else {
    // Fallback: use generic patterns to remove chatbot lines
    cleanText = cleanText
      .replace(/(?:A minuta (?:de sentença )?está pronta|Deseja realizar (?:algum|quaisquer) ajuste|Como braço direito|Se desejar realizar|Se precisar de|Estou à disposição)[\s\S]*$/i, '')
      .trim();
  }

  const lines = cleanText.split('\n');
  const paragraphs = [];

  for (const line of lines) {
    if (line.trim() === '') {
      // "Não aplique espaçamento adicional entre parágrafos" -> skip empty lines
      continue;
    }

    let processedLine = line.trim();
    
    // Custom Numbering logic (I, II, III for main sections, remove others)
    const normalized = processedLine.replace(/[*#]/g, '').trim().toUpperCase();
    const isRelatorio = /^(I\s*[-–—]?\s*)?RELATÓR?IO:?$/.test(normalized);
    const isFundamentacao = /^(II\s*[-–—]?\s*)?FUNDAMENTAÇ[AÃ]O:?$/.test(normalized);
    const isDispositivo = /^(III\s*[-–—]?\s*)?DISPOSITIVO:?$/.test(normalized);

    let isHeader = false;
    if (isRelatorio) {
        processedLine = "I - RELATÓRIO";
        isHeader = true;
    } else if (isFundamentacao) {
        processedLine = "II - FUNDAMENTAÇÃO";
        isHeader = true;
    } else if (isDispositivo) {
        processedLine = "III - DISPOSITIVO";
        isHeader = true;
    } else {
        // Remove existing numeric prefixes like "1.", "1.1", "2)"
        processedLine = processedLine.replace(/^(\d+(\.\d+)*[\s\.)\-]+)/, '');
    }

    const runs = [];
    let currentText = '';
    let isBold = false;
    let isItalic = false;

    // Determine basic styling BEFORE parsing markdown to handle entire line bolding
    const isTitle = isHeader || (processedLine === processedLine.toUpperCase() && processedLine.length > 5 && processedLine.length < 100);

    // Check if the line is precisely the word "SENTENÇA" (normalized, removing asterisks and hash symbols) or contains "SENTENÇA DE EMBARGOS DE DECLARAÇÃO"
    const isSentencaWord = normalized === "SENTENÇA" || normalized === "SENTENCA" || normalized.includes("SENTENÇA DE EMBARGOS") || normalized.includes("SENTENCA DE EMBARGOS");

    // Simple markdown parser for bold (**) and italic (*)
    for (let i = 0; i < processedLine.length; i++) {
        if (processedLine[i] === '*' && processedLine[i+1] === '*') {
            if (currentText) {
                runs.push(new TextRun({ text: currentText, bold: isBold || isTitle, italics: isItalic, font: "Times New Roman", size: 24 }));
                currentText = '';
            }
            isBold = !isBold;
            i++; 
        } else if (processedLine[i] === '*') {
            if (currentText) {
                runs.push(new TextRun({ text: currentText, bold: isBold || isTitle, italics: isItalic, font: "Times New Roman", size: 24 }));
                currentText = '';
            }
            isItalic = !isItalic;
        } else {
            currentText += processedLine[i];
        }
    }
    
    if (currentText) {
        runs.push(new TextRun({ text: currentText, bold: isBold || isTitle, italics: isItalic, font: "Times New Roman", size: 24 }));
    }

    // Set custom spacing based on element type
    // If it's a heading (title/subtitle), add space before & after.
    // If it's a normal paragraph, do not add paragraph spacing (after: 0) as requested.
    const spacingConfig = isTitle 
      ? { before: 240, after: 120, line: 360 } 
      : { before: 0, after: 0, line: 360 };

    const alignmentValue = isSentencaWord ? AlignmentType.CENTER : AlignmentType.JUSTIFIED;
    const indentConfig = alignmentValue !== AlignmentType.CENTER 
      ? { firstLine: 850 } 
      : undefined;

    paragraphs.push(
      new Paragraph({
        children: runs,
        alignment: alignmentValue,
        spacing: spacingConfig,
        indent: indentConfig
      })
    );
  }

  const doc = new Document({
    creator: "Assistente Jurídico AI",
    title: "Minuta de Sentença Trabalhista",
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440,    // 1 inch = 1440 twips
              right: 1440,
              bottom: 1440,
              left: 1440,
            },
          },
        },
        children: paragraphs,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  
  // Attempt to save to Google Drive if access token is present
  try {
    const token = await getAccessToken();
    if (token) {
      await uploadToGoogleDrive(blob, filename, token);
    }
  } catch (err) {
    console.error("Could not obtain access token or upload to drive", err);
  }
  
  saveAs(blob, filename);
}
