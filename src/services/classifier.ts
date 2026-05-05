export interface ClassificationResult {
  classifications: {
    categoryId: number;
    subCategoryName: string;
  }[];
  suggestedTitle: string;
}

export async function classifyImage(base64Image: string, mimeType: string): Promise<ClassificationResult> {
  try {
    const response = await fetch('/api/classify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ base64Image, mimeType })
    });
    
    if (!response.ok) {
      let errData = { error: "Unknown error", details: "" };
      try { errData = await response.json(); } catch(e) {}
      throw new Error(`API error ${response.status}: ${errData.details || errData.error}`);
    }
    
    return await response.json();
  } catch (error: any) {
    console.error("Classification error:", error);
    throw error; // Let App.tsx handle it so it doesn't just silently fallback
  }
}
