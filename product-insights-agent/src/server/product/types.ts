export interface ProductData {
  id: string;
  name: string;
  brand: string;
  model: string;
  price: number;
  currency: string;
  description: string;
  features: string[];
  specifications: Record<string, string>;
  images: string[];
  category: string;
  url?: string;
}

export interface ProductDataAdapter {
  getProduct(productId: string): Promise<ProductData>;
}
