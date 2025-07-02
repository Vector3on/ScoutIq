import torch
import torch.nn as nn
import torch.optim as optim
import pandas as pd
from sklearn.preprocessing import MinMaxScaler
import time

# --- DLinear Model Components ---

class MovingAvg(nn.Module):
    """
    A moving average layer used to decompose the time series into trend and seasonality.
    This is a key component of the DLinear architecture.
    """
    def __init__(self, kernel_size):
        super(MovingAvg, self).__init__()
        self.kernel_size = kernel_size
        self.avg = nn.AvgPool1d(kernel_size=kernel_size, stride=1, padding=0)

    def forward(self, x):
        # Pad the beginning of the series to maintain length
        front = x[:, 0:1, :].repeat(1, (self.kernel_size - 1) // 2, 1)
        end = x[:, -1:, :].repeat(1, (self.kernel_size - 1) // 2, 1)
        x = torch.cat([front, x, end], dim=1)
        x = self.avg(x.permute(0, 2, 1))
        x = x.permute(0, 2, 1)
        return x

class DLinear(nn.Module):
    """
    The DLinear model, based on the paper "Are Transformers Effective for Time Series Forecasting?".
    It decomposes the input and applies a separate linear layer to the trend and seasonal components.
    """
    def __init__(self, input_seq_len, output_seq_len, kernel_size=25):
        super(DLinear, self).__init__()
        self.input_seq_len = input_seq_len
        self.output_seq_len = output_seq_len
        self.decomposer = MovingAvg(kernel_size)
        
        # Linear layers for trend and seasonal components
        self.linear_seasonal = nn.Linear(input_seq_len, output_seq_len)
        self.linear_trend = nn.Linear(input_seq_len, output_seq_len)

    def forward(self, x):
        # x shape: [Batch, Input Length, Features]
        seasonal_init, trend_init = self.decomposer(x), x - self.decomposer(x)
        
        seasonal_output = self.linear_seasonal(seasonal_init.permute(0, 2, 1)).permute(0, 2, 1)
        trend_output = self.linear_trend(trend_init.permute(0, 2, 1)).permute(0, 2, 1)
        
        # The final forecast is the sum of the two component forecasts
        return seasonal_output + trend_output

# --- Forecasting Function ---

def generate_forecast(data: pd.DataFrame, target_column: str, input_seq_len: int, output_seq_len: int, epochs: int = 100):
    """
    Generates a forecast using the DLinear model.
    
    Args:
        data (pd.DataFrame): DataFrame containing the time series data.
        target_column (str): The name of the column to forecast.
        input_seq_len (int): The number of past time steps to use as input.
        output_seq_len (int): The number of future time steps to forecast.
        epochs (int): The number of training epochs.

    Returns:
        A numpy array containing the forecast.
    """
    print(f"📈 Starting DLinear forecast for '{target_column}'...")
    
    # 1. Prepare Data
    scaler = MinMaxScaler()
    scaled_data = scaler.fit_transform(data[[target_column]])
    
    # Create sequences
    X, y = [], []
    for i in range(len(scaled_data) - input_seq_len - output_seq_len + 1):
        X.append(scaled_data[i : i + input_seq_len])
        y.append(scaled_data[i + input_seq_len : i + input_seq_len + output_seq_len])

    X_tensor = torch.FloatTensor(X)
    y_tensor = torch.FloatTensor(y)
    
    # 2. Initialize Model and Optimizer
    model = DLinear(input_seq_len, output_seq_len)
    optimizer = optim.Adam(model.parameters(), lr=0.001)
    criterion = nn.MSELoss()
    
    # 3. Simplified Training Loop
    start_time = time.time()
    for epoch in range(epochs):
        model.train()
        optimizer.zero_grad()
        output = model(X_tensor)
        loss = criterion(output, y_tensor)
        loss.backward()
        optimizer.step()
        
        if (epoch + 1) % 20 == 0:
            print(f'Epoch [{epoch+1}/{epochs}], Loss: {loss.item():.6f}')
    
    training_time = time.time() - start_time
    print(f"✅ Training finished in {training_time:.2f} seconds.")

    # 4. Generate Final Forecast
    model.eval()
    with torch.no_grad():
        last_sequence = torch.FloatTensor(scaled_data[-input_seq_len:]).unsqueeze(0)
        forecast_scaled = model(last_sequence)
    
    # 5. Inverse transform to get actual values
    forecast = scaler.inverse_transform(forecast_scaled.squeeze(0).numpy())
    
    return forecast.flatten()

if __name__ == '__main__':
    # --- Example Usage ---
    
    # 1. Create mock data
    print("⚙️ Creating mock data...")
    mock_data = {
        'date': pd.to_datetime(pd.date_range(start='2024-01-01', periods=120, freq='D')),
        'stars': [i + 10 * (i // 30) + (i % 20) for i in range(120)]
    }
    df = pd.DataFrame(mock_data)
    
    INPUT_LEN = 90
    OUTPUT_LEN = 30
    
    # 2. Generate forecast
    forecast_values = generate_forecast(
        data=df,
        target_column='stars',
        input_seq_len=INPUT_LEN,
        output_seq_len=OUTPUT_LEN
    )
    
    # 3. Save the forecast to a CSV file
    print("💾 Saving forecast to CSV...")
    
    # Create future dates for the forecast
    last_date = df['date'].iloc[-1]
    future_dates = pd.date_range(start=last_date + pd.Timedelta(days=1), periods=OUTPUT_LEN, freq='D')
    
    # Create a new DataFrame for the forecast
    forecast_df = pd.DataFrame({'date': future_dates, 'forecasted_stars': forecast_values})
    
    # Save to CSV
    forecast_df.to_csv('forecast.csv', index=False)
    
    print("\n--- ✅ Forecast Complete ---")
    print(f"Prediction saved to 'forecast.csv'. You can find this file in the explorer.")
    print("--------------------------")